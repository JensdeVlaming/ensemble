import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { leaseClaim } from "./lease-helpers.ts";
import {
  CodexRuntime,
  EngineExecutionService,
  ExecutionEngine,
  GitRepositoryDriver,
  InMemoryProvider,
  LocalWorkspaceManager,
  RepositoryConfigLoader,
  RuntimeRegistry,
  Scheduler,
  ScriptedRuntime,
  WorkspaceConfigurationResolver,
  parseSimpleYaml,
} from "../src/index.ts";
import type { CodexTransport, CodexTransportSession, RepositoryRef, Runtime, Task, Workspace, WorkspaceManager } from "../src/index.ts";
import type { ExecutionCompletion, ProviderAdapter, TaskId } from "../src/index.ts";

const repository: RepositoryRef = { id: "ensemble", url: "local://ensemble" };
const execute = promisify(execFile);

function task(id: string, status = "todo"): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "Implement it",
    acceptanceCriteria: ["It works"],
    status,
    labels: [],
    assignees: [],
    repository,
  };
}

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-test-"));
  await mkdir(join(root, ".ensemble", "roles"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Use strict TypeScript.\n");
  await writeFile(join(root, ".ensemble", "WORKFLOW.md"), "Implement, then review.\n");
  await writeFile(join(root, ".ensemble", "roles", "implementation.md"), "Implement the task.\n");
  await writeFile(join(root, ".ensemble", "roles", "reviewer.md"), "Review the changes.\n");
  await writeFile(join(root, ".ensemble", "config.yaml"), [
    "runtime:",
    "  name: scripted",
    "  config:",
    "    effort: high",
    "initialRole: implementation",
    "terminalOutcomes: [approved, completed]",
    "statuses:",
    "  runnable: [todo, in_progress]",
    "  running: in_progress",
    "  completed: done",
    "  failed: failed",
    "retry:",
    "  maxFailedAttemptsPerRole: 3",
  ].join("\n"));
  return root;
}

class FixedWorkspaces implements WorkspaceManager {
  readonly #repositoryPath: string;
  constructor(repositoryPath: string) { this.#repositoryPath = repositoryPath; }
  async create(item: Task): Promise<Workspace> {
    return { root: `/workspaces/${item.id}`, repositoryPath: this.#repositoryPath, runtimePath: `/workspaces/${item.id}/.ensemble-runtime` };
  }
  async restore(_item: Task): Promise<Workspace | undefined> { return undefined; }
  async cleanup(_workspace: Workspace): Promise<void> {}
}

test("local workspaces create, restore, and apply cleanup policy", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspaces-"));
  const materialized: string[] = [];
  const repositories = {
    async materialize(_reference: RepositoryRef, target: string): Promise<void> {
      materialized.push(target);
      await mkdir(target);
      await writeFile(join(target, "README.md"), "materialized");
    },
  };
  const preserved = new LocalWorkspaceManager(base, repositories);
  const created = await preserved.create(task("Task / 42"));
  assert.equal(dirname(created.root), base);
  assert.match(basename(created.root), /^task-42--[a-f0-9]{20}$/u);
  assert.deepEqual(materialized, [created.repositoryPath]);
  assert.equal(await readFile(join(created.repositoryPath, "README.md"), "utf8"), "materialized");
  assert.equal((await stat(created.runtimePath)).isDirectory(), true);
  const manifestPath = join(created.runtimePath, "workspace.json");
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), {
    schemaVersion: 1, namespace: "local", taskId: "Task / 42", repository,
  });
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(await preserved.restore(task("Task / 42")), created);
  await preserved.cleanup(created);
  assert.equal((await stat(created.root)).isDirectory(), true);

  const disposable = new LocalWorkspaceManager(base, repositories, false);
  const disposableRestore = await disposable.restore(task("Task / 42"));
  assert.ok(disposableRestore);
  await disposable.cleanup(disposableRestore);
  assert.equal(await disposable.restore(task("Task / 42")), undefined);
});

test("local workspace creation removes partial materialization failures", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-failure-"));
  const manager = new LocalWorkspaceManager(base, {
    async materialize(_reference, target): Promise<void> {
      await mkdir(target);
      await writeFile(join(target, "partial"), "incomplete");
      throw new Error("clone failed");
    },
  });
  await assert.rejects(manager.create(task("partial-1")), /clone failed/u);
  await assert.rejects(stat(join(base, "partial-1")), { code: "ENOENT" });
});

test("local workspace cleanup rejects paths outside its absolute root", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-root-"));
  const outside = await mkdtemp(join(tmpdir(), "ensemble-workspace-outside-"));
  const manager = new LocalWorkspaceManager(base, { materialize: async () => undefined }, false);
  await assert.rejects(manager.cleanup({
    root: outside,
    repositoryPath: join(outside, "repository"),
    runtimePath: join(outside, ".ensemble-runtime"),
  }), /direct child/u);
  assert.equal((await stat(outside)).isDirectory(), true);
  assert.throws(() => new LocalWorkspaceManager("relative", { materialize: async () => undefined }), /absolute/u);
});

test("workspace identities resist normalized collisions and separate namespaces", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-identity-"));
  const repositories = { materialize: async (_reference: RepositoryRef, target: string) => { await mkdir(target); } };
  const firstManager = new LocalWorkspaceManager(base, repositories, true, "vikunja:ensemble");
  const first = await firstManager.create(task("A/B"));
  const collision = await firstManager.create(task("A B"));
  const otherNamespace = await new LocalWorkspaceManager(base, repositories, true, "github:ensemble").create(task("A/B"));
  assert.equal(new Set([first.root, collision.root, otherNamespace.root]).size, 3);
  assert.match(basename(first.root), /^a-b--[a-f0-9]{20}$/u);
  assert.deepEqual(await firstManager.restore(task("A/B")), first);
  assert.deepEqual(await new LocalWorkspaceManager(base, repositories, true, "github:ensemble").restore(task("A/B")), otherNamespace);
});

test("workspace manifests fail closed on tampering, permissions, size, and symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-manifest-"));
  const repositories = { materialize: async (_reference: RepositoryRef, target: string) => { await mkdir(target); } };

  const tamperedManager = new LocalWorkspaceManager(base, repositories, true, "vikunja:tampered");
  const tampered = await tamperedManager.create(task("tampered"));
  const tamperedManifest = join(tampered.runtimePath, "workspace.json");
  await writeFile(tamperedManifest, JSON.stringify({ schemaVersion: 1, namespace: "wrong", taskId: "tampered", repository, extra: true }));
  await assert.rejects(tamperedManager.restore(task("tampered")), /manifest/u);

  const modeManager = new LocalWorkspaceManager(base, repositories, true, "vikunja:mode");
  const unsafeMode = await modeManager.create(task("mode"));
  await chmod(join(unsafeMode.runtimePath, "workspace.json"), 0o644);
  await assert.rejects(modeManager.restore(task("mode")), /unsafe/u);

  const largeManager = new LocalWorkspaceManager(base, repositories, true, "vikunja:large");
  const oversized = await largeManager.create(task("large"));
  await writeFile(join(oversized.runtimePath, "workspace.json"), "x".repeat(16_385), { mode: 0o600 });
  await assert.rejects(largeManager.restore(task("large")), /unsafe|large/u);

  const linkManager = new LocalWorkspaceManager(base, repositories, true, "vikunja:link");
  const linked = await linkManager.create(task("link"));
  const outside = join(await mkdtemp(join(tmpdir(), "ensemble-manifest-outside-")), "workspace.json");
  await writeFile(outside, JSON.stringify({ schemaVersion: 1, namespace: "vikunja:link", taskId: "link", repository }));
  await unlink(join(linked.runtimePath, "workspace.json"));
  await symlink(outside, join(linked.runtimePath, "workspace.json"));
  await assert.rejects(linkManager.restore(task("link")), /unsafe/u);
});

test("workspace validation and deletion reject repository symlink replacement", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "ensemble-workspace-safe-outside-"));
  await writeFile(join(outside, "keep"), "safe");
  const manager = new LocalWorkspaceManager(base, {
    materialize: async (_reference, target) => { await mkdir(target); },
  }, false, "vikunja:symlink");
  const workspace = await manager.create(task("symlink"));
  await rename(workspace.repositoryPath, `${workspace.repositoryPath}-original`);
  await symlink(outside, workspace.repositoryPath);
  await assert.rejects(manager.validate(workspace), /invalid directory|symbolic link|filesystem identity changed/u);
  await assert.rejects(manager.cleanup(workspace), /invalid directory|symbolic link|filesystem identity changed/u);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "safe");
  assert.equal((await lstat(workspace.root)).isDirectory(), true);
});

test("workspace validation pins the allocated manifest, root, and configured root identities", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ensemble-workspace-pinned-"));
  const base = join(parent, "workspaces");
  const repositories = { materialize: async (_reference: RepositoryRef, target: string) => { await mkdir(target); } };
  const manager = new LocalWorkspaceManager(base, repositories, false, "vikunja:pinned");
  const workspace = await manager.create(task("pinned"));
  const manifestPath = join(workspace.runtimePath, "workspace.json");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, namespace: "vikunja:pinned", taskId: "pinned",
    repository: { ...repository, url: "local://replacement" } }), { mode: 0o600 });
  await assert.rejects(manager.validate(workspace), /identity changed/u);

  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, namespace: "vikunja:pinned", taskId: "pinned", repository }), { mode: 0o600 });
  const originalRoot = `${workspace.root}-original`;
  await rename(workspace.root, originalRoot);
  await mkdir(workspace.repositoryPath, { recursive: true });
  await mkdir(workspace.runtimePath);
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, namespace: "vikunja:pinned", taskId: "pinned", repository }), { mode: 0o600 });
  await assert.rejects(manager.validate(workspace), /filesystem identity changed/u);
  await assert.rejects(manager.cleanup(workspace), /filesystem identity changed/u);

  const rootManager = new LocalWorkspaceManager(base, repositories, true, "vikunja:base-pinned");
  await rootManager.create(task("base-pinned"));
  await rename(base, `${base}-original`);
  await mkdir(base);
  await assert.rejects(rootManager.restore(task("base-pinned")), /root identity changed/u);
});

test("workspace validation pins repository/runtime entries and rejects an unsafe configured root", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-components-"));
  const repositories = { materialize: async (_reference: RepositoryRef, target: string) => { await mkdir(target); } };
  const manager = new LocalWorkspaceManager(base, repositories, true, "vikunja:components");
  const repositoryWorkspace = await manager.create(task("repository-component"));
  await rename(repositoryWorkspace.repositoryPath, `${repositoryWorkspace.repositoryPath}-original`);
  await mkdir(repositoryWorkspace.repositoryPath, { mode: 0o755 });
  await assert.rejects(manager.validate(repositoryWorkspace), /filesystem identity changed/u);

  const runtimeWorkspace = await manager.create(task("runtime-component"));
  const manifest = await readFile(join(runtimeWorkspace.runtimePath, "workspace.json"));
  await rename(runtimeWorkspace.runtimePath, `${runtimeWorkspace.runtimePath}-original`);
  await mkdir(runtimeWorkspace.runtimePath, { mode: 0o700 });
  await writeFile(join(runtimeWorkspace.runtimePath, "workspace.json"), manifest, { mode: 0o600 });
  await assert.rejects(manager.validate(runtimeWorkspace), /filesystem identity changed/u);

  const unsafeBase = await mkdtemp(join(tmpdir(), "ensemble-workspace-unsafe-base-"));
  await chmod(unsafeBase, 0o777);
  const unsafe = new LocalWorkspaceManager(unsafeBase, repositories, true, "vikunja:unsafe");
  await assert.rejects(unsafe.classifyLegacy([]), /ownership or permissions are unsafe/u);
});

test("legacy workspaces are opaque, classified exactly, migrated before use, and quarantined safely", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-legacy-"));
  const legacyRoot = join(base, "a-b");
  await mkdir(join(legacyRoot, "repository"), { recursive: true });
  await mkdir(join(legacyRoot, ".ensemble-runtime"));
  const repositories = { materialize: async (_reference: RepositoryRef, target: string) => { await mkdir(target); } };
  const manager = new LocalWorkspaceManager(base, repositories, true, "vikunja:ensemble");

  assert.equal(await manager.restore(task("A/B")), undefined);
  const [ambiguous] = await manager.classifyLegacy([task("A/B"), task("A B")]);
  assert.equal(ambiguous?.kind, "ambiguous");
  assert.doesNotMatch(JSON.stringify(ambiguous), new RegExp(base, "u"));

  const [unique] = await manager.classifyLegacy([task("A/B")]);
  assert.equal(unique?.kind, "unique");
  assert.ok(unique?.kind === "unique");
  const migrated = await manager.migrateLegacy(unique, task("A/B"));
  assert.notEqual(migrated.root, legacyRoot);
  assert.deepEqual(await manager.restore(task("A/B")), migrated);
  await assert.rejects(manager.migrateLegacy(unique, task("A/B")), /already used/u);

  const orphan = join(base, "orphan");
  await mkdir(join(orphan, "repository"), { recursive: true });
  await mkdir(join(orphan, ".ensemble-runtime"));
  const unmatched = (await manager.classifyLegacy([task("A/B")])).find((match) => match.kind === "unmatched");
  assert.ok(unmatched);
  await manager.quarantineLegacy(unmatched.handle);
  assert.equal((await readdir(base)).some((name) => name.startsWith(".ensemble-quarantine-")), true);
  await assert.rejects(manager.quarantineLegacy(unmatched.handle), /already used/u);

  const replacedRoot = join(base, "replace-me");
  await mkdir(join(replacedRoot, "repository"), { recursive: true });
  await mkdir(join(replacedRoot, ".ensemble-runtime"));
  const replaced = (await manager.classifyLegacy([])).find((match) => match.kind === "unmatched"
    && match.handle.id !== unmatched.handle.id);
  assert.ok(replaced);
  await rename(replacedRoot, `${replacedRoot}-original`);
  await mkdir(replacedRoot);
  await assert.rejects(manager.removeLegacy(replaced.handle), /filesystem identity changed/u);
  assert.equal((await lstat(replacedRoot)).isDirectory(), true);
});

test("git repository materialization selects the configured branch", async () => {
  const source = await mkdtemp(join(tmpdir(), "ensemble-git-source-"));
  await execute("git", ["init", "--quiet", "--initial-branch=main", source]);
  await execute("git", ["-C", source, "config", "user.email", "ensemble@example.test"]);
  await execute("git", ["-C", source, "config", "user.name", "Ensemble Test"]);
  await writeFile(join(source, "branch.txt"), "main");
  await execute("git", ["-C", source, "add", "branch.txt"]);
  await execute("git", ["-C", source, "commit", "--quiet", "-m", "main"]);
  await execute("git", ["-C", source, "checkout", "--quiet", "-b", "feature"]);
  await writeFile(join(source, "branch.txt"), "feature");
  await execute("git", ["-C", source, "commit", "--quiet", "-am", "feature"]);

  const destination = join(await mkdtemp(join(tmpdir(), "ensemble-git-target-")), "repository");
  await new GitRepositoryDriver().materialize(
    { id: "local", url: source, defaultBranch: "main", branch: "feature" },
    destination,
  );
  assert.equal(await readFile(join(destination, "branch.txt"), "utf8"), "feature");
  assert.equal((await execute("git", ["-C", destination, "branch", "--show-current"])).stdout.trim(), "feature");
});

test("git refresh verifies identity, fast-forwards clean work, and preserves dirty or local work", async () => {
  const source = await mkdtemp(join(tmpdir(), "ensemble-git-refresh-source-"));
  await execute("git", ["init", "--quiet", "--initial-branch=main", source]);
  await execute("git", ["-C", source, "config", "user.email", "ensemble@example.test"]);
  await execute("git", ["-C", source, "config", "user.name", "Ensemble Test"]);
  await writeFile(join(source, "tracked.txt"), "one\n");
  await execute("git", ["-C", source, "add", "tracked.txt"]);
  await execute("git", ["-C", source, "commit", "--quiet", "-m", "one"]);
  const target = join(await mkdtemp(join(tmpdir(), "ensemble-git-refresh-target-")), "repository");
  const driver = new GitRepositoryDriver("git", 5_000);
  const reference = { id: "refresh", url: source, branch: "main" };
  await driver.materialize(reference, target);

  await writeFile(join(source, "tracked.txt"), "two\n");
  await execute("git", ["-C", source, "commit", "--quiet", "-am", "two"]);
  await driver.refresh(reference, target);
  assert.equal(await readFile(join(target, "tracked.txt"), "utf8"), "two\n");

  const cleanHead = (await execute("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(target, "local.txt"), "dirty\n");
  await writeFile(join(source, "upstream.txt"), "upstream\n");
  await execute("git", ["-C", source, "add", "upstream.txt"]);
  await execute("git", ["-C", source, "commit", "--quiet", "-m", "upstream"]);
  await driver.refresh(reference, target);
  assert.equal((await execute("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim(), cleanHead);
  assert.equal(await readFile(join(target, "local.txt"), "utf8"), "dirty\n");

  await execute("git", ["-C", target, "config", "user.email", "ensemble@example.test"]);
  await execute("git", ["-C", target, "config", "user.name", "Ensemble Test"]);
  await execute("git", ["-C", target, "add", "local.txt"]);
  await execute("git", ["-C", target, "commit", "--quiet", "-m", "local"]);
  const localHead = (await execute("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim();
  await driver.refresh(reference, target);
  assert.equal((await execute("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim(), localHead);

  await assert.rejects(driver.refresh({ ...reference, url: `${source}-other` }, target), /origin/u);
  await assert.rejects(driver.refresh({ ...reference, branch: "feature" }, target), /branch/u);
});

test("repository commands use a minimal environment and bounded output and time", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-git-boundary-"));
  const noisy = join(root, "noisy-git");
  await writeFile(noisy, `#!${process.execPath}\nif(process.env.VIKUNJA_TOKEN)process.stderr.write(process.env.VIKUNJA_TOKEN);process.stdout.write('x'.repeat(70000));\n`);
  await chmod(noisy, 0o700);
  const previous = process.env.VIKUNJA_TOKEN;
  process.env.VIKUNJA_TOKEN = "provider-secret-sentinel";
  try {
    await assert.rejects(new GitRepositoryDriver(noisy, 1_000).refresh({ id: "x", url: "local://x" }, root), (error: unknown) => {
      assert.equal((error as Error).message, "Repository command output exceeded its limit");
      assert.doesNotMatch(String(error), /provider-secret-sentinel/u);
      return true;
    });
    const hanging = join(root, "hanging-git");
    await writeFile(hanging, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
    await chmod(hanging, 0o700);
    await assert.rejects(new GitRepositoryDriver(hanging, 10).refresh({ id: "x", url: "local://x" }, root), /timed out/u);
  } finally {
    if (previous === undefined) delete process.env.VIKUNJA_TOKEN;
    else process.env.VIKUNJA_TOKEN = previous;
  }
});

test("workspace restoration refreshes the pinned repository before returning it", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-workspace-refresh-"));
  let refreshes = 0;
  const repositories = {
    materialize: async (_reference: RepositoryRef, target: string) => { await mkdir(target); },
    refresh: async (reference: RepositoryRef, target: string) => {
      refreshes += 1;
      assert.deepEqual(reference, repository);
      assert.equal((await lstat(target)).isDirectory(), true);
    },
  };
  const creator = new LocalWorkspaceManager(base, repositories, true, "vikunja:refresh");
  await creator.create(task("refresh"));
  assert.equal(refreshes, 0);
  const restorer = new LocalWorkspaceManager(base, repositories, true, "vikunja:refresh");
  assert.ok(await restorer.restore(task("refresh")));
  assert.equal(refreshes, 1);
});

test("configuration is completely repository-defined", async () => {
  const root = await fixtureRepository();
  const config = await new RepositoryConfigLoader().load(repository, root);
  assert.equal(config.runtime.name, "scripted");
  assert.deepEqual(config.runtime.config, { effort: "high" });
  assert.deepEqual(config.workflow.roles.map((role) => role.name), ["implementation", "reviewer"]);
  assert.match(config.agents, /strict TypeScript/u);
});

test("repository YAML accepts block sequences through the stable parser export", () => {
  assert.deepEqual(parseSimpleYaml("items:\n  - one\n  - two").items, ["one", "two"]);
});

test("scheduler is deterministic and synchronizes structured results", async () => {
  const root = await fixtureRepository();
  const provider = new InMemoryProvider([task("task-20"), task("task-3")]);
  const runtime = new ScriptedRuntime("scripted", {
    outcome: "approved",
    summary: "Implementation complete",
    comments: ["Validation passed"],
    artifacts: [{ type: "pull_request", url: "https://example.test/pr/1" }],
  });
  const observed: string[] = [];
  const engine = new ExecutionEngine(new RuntimeRegistry([runtime]), new FixedWorkspaces(root),
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root), (event, item) => {
    if (event.type === "run_started") observed.push(item.id);
  });
  const scheduler = new Scheduler(
    provider, new EngineExecutionService(engine),
  );

  const reports = await scheduler.poll();
  assert.deepEqual(reports.map((report) => report.taskId), ["task-20", "task-3"]);
  assert.deepEqual(observed, ["task-20", "task-3"]);
  assert.equal((await provider.getTask("task-3")).status, "done");
  assert.deepEqual((await provider.getComments("task-3")).map((comment) => comment.body), ["Validation passed", "Implementation complete"]);
  assert.equal((await provider.getArtifacts("task-3")).length, 1);
  assert.equal(runtime.contexts[0]?.role.name, "implementation");
  assert.equal((await provider.getExecutionState("task-3")).nextRole, undefined);
});

test("a non-terminal result requires a valid next role", async () => {
  const root = await fixtureRepository();
  const provider = new InMemoryProvider([task("task-1")]);
  const runtime = new ScriptedRuntime("scripted", {
    outcome: "changes_requested",
    summary: "Needs review",
    nextRole: "missing-role",
    comments: [],
    artifacts: [],
  });
  const scheduler = new Scheduler(
    provider, new EngineExecutionService(new ExecutionEngine(new RuntimeRegistry([runtime]),
      new FixedWorkspaces(root), new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root))),
  );
  const [report] = await scheduler.poll();
  assert.equal(report?.outcome, "failed");
  assert.match(report?.error ?? "", /unknown next role/u);
  assert.equal((await provider.getTask("task-1")).status, "failed");
  assert.deepEqual(await provider.getArtifacts("task-1"), []);
});

test("provider state selects the next role after scheduler reconstruction", async () => {
  const root = await fixtureRepository();
  const provider = new InMemoryProvider([task("task-2")]);
  const implementation = new ScriptedRuntime("scripted", {
    outcome: "ready_for_review",
    summary: "Ready",
    nextRole: "reviewer",
    comments: [],
    artifacts: [],
  });
  const makeScheduler = (runtime: ScriptedRuntime) => new Scheduler(
    provider, new EngineExecutionService(new ExecutionEngine(new RuntimeRegistry([runtime]),
      new FixedWorkspaces(root), new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root))),
  );
  assert.equal((await makeScheduler(implementation).poll())[0]?.outcome, "advanced");
  assert.equal((await provider.getExecutionState("task-2")).nextRole, "reviewer");

  const reviewer = new ScriptedRuntime("scripted", {
    outcome: "approved",
    summary: "Approved",
    comments: [],
    artifacts: [],
  });
  assert.equal((await makeScheduler(reviewer).poll())[0]?.role, "reviewer");
  assert.equal(reviewer.contexts[0]?.role.name, "reviewer");
  assert.equal((await provider.getTask("task-2")).status, "done");
  assert.equal((await provider.getExecutionState("task-2")).history.length, 2);
});

test("a reconstructed scheduler recovers a durable in-progress execution", async () => {
  const root = await fixtureRepository();
  const provider = new InMemoryProvider([task("restart-1")]);
  const started = await provider.beginExecution("restart-1", "implementation", "in_progress", leaseClaim());
  const runtime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "Recovered", comments: [], artifacts: [] });
  const scheduler = new Scheduler(provider, new EngineExecutionService(new ExecutionEngine(new RuntimeRegistry([runtime]),
    new FixedWorkspaces(root), new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root))));
  assert.equal((await scheduler.poll())[0]?.outcome, "completed");
  assert.equal((await provider.getTask("restart-1")).status, "done");
  assert.equal((await provider.getExecutionState("restart-1")).history[0]?.id, started.id);
  assert.equal(runtime.contexts[0]?.role.name, "implementation");
});

test("repository-defined custom runnable statuses are discoverable", async () => {
  const root = await fixtureRepository();
  await writeFile(join(root, ".ensemble", "config.yaml"), [
    "runtime:", "  name: scripted", "initialRole: implementation", "terminalOutcomes: [approved]",
    "statuses:", "  runnable: [queued]", "  running: underway", "  completed: shipped", "  failed: failed",
  ].join("\n"));
  const provider = new InMemoryProvider([task("custom-1", "queued"), task("ignored", "todo")]);
  const runtime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "Done", comments: [], artifacts: [] });
  const scheduler = new Scheduler(provider, new EngineExecutionService(new ExecutionEngine(new RuntimeRegistry([runtime]),
    new FixedWorkspaces(root), new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root))));
  assert.deepEqual((await scheduler.poll()).map((item) => item.taskId), ["custom-1"]);
  assert.equal((await provider.getTask("custom-1")).status, "shipped");
  assert.equal((await provider.getTask("ignored")).status, "todo");
});

test("a provider response failure after atomic completion is safe to retry", async () => {
  const root = await fixtureRepository();
  const delegate = new InMemoryProvider([task("retry-1")]);
  let failResponse = true;
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "completeExecution") return async (id: TaskId, executionId: string, lease: Parameters<ProviderAdapter["completeExecution"]>[2], completion: ExecutionCompletion) => {
        await target.completeExecution(id, executionId, lease, completion);
        if (failResponse) { failResponse = false; throw new Error("provider response lost"); }
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const runtime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "Once", comments: ["One"], artifacts: [] });
  const makeScheduler = () => new Scheduler(provider, new EngineExecutionService(new ExecutionEngine(new RuntimeRegistry([runtime]),
    new FixedWorkspaces(root), new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root))));
  assert.equal((await makeScheduler().poll())[0]?.outcome, "failed");
  assert.deepEqual(await makeScheduler().poll(), []);
  assert.deepEqual((await delegate.getComments("retry-1")).map((item) => item.body), ["One", "Once"]);
  assert.equal((await delegate.getExecutionState("retry-1")).history.length, 1);
});

test("runtime failure is durably recorded and workspace cleanup still runs", async () => {
  const root = await fixtureRepository();
  const provider = new InMemoryProvider([task("failure-1")]);
  let cleaned = 0;
  const workspaces: WorkspaceManager = {
    create: async (item) => ({ root: `/w/${item.id}`, repositoryPath: root, runtimePath: `/w/${item.id}/runtime` }),
    restore: async () => undefined,
    cleanup: async () => { cleaned += 1; },
  };
  const runtime: Runtime = {
    name: "scripted",
    prepare: async (context) => ({ id: "failure-session", context, payload: null }),
    start: async () => ({ id: "failure-session", events: (async function* () {})(), result: Promise.reject(new Error("runtime exploded")) }),
    resume: async (session) => session,
    cancel: async () => undefined,
  };
  const scheduler = new Scheduler(provider, new EngineExecutionService(new ExecutionEngine(new RuntimeRegistry([runtime]),
    workspaces, new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root))));
  assert.equal((await scheduler.poll())[0]?.outcome, "failed");
  assert.equal((await provider.getTask("failure-1")).status, "failed");
  assert.equal(cleaned, 1);
});

test("Codex runtime owns prompt construction, event parsing, and result parsing", async () => {
  const root = await fixtureRepository();
  const config = await new RepositoryConfigLoader().load(repository, root);
  const calls: Array<{ prompt: string; cwd: string }> = [];
  const transport: CodexTransport = {
    async start(request): Promise<CodexTransportSession> {
      calls.push({ prompt: request.prompt, cwd: request.cwd });
      return {
        id: request.id,
        messages: (async function* () {
          yield { type: "progress_updated", message: "Working" };
          yield { type: "artifact_created", artifact: { type: "patch", url: "file:///patch.diff" } };
        })(),
        result: Promise.resolve({ outcome: "approved", summary: "Done", comments: [], artifacts: [] }),
      };
    },
    async resume(session): Promise<CodexTransportSession> { return session; },
    async cancel(): Promise<void> {},
  };
  const runtime = new CodexRuntime(transport);
  const prepared = await runtime.prepare({
    executionId: "codex-execution",
    repository,
    workspace: { root, repositoryPath: root, runtimePath: join(root, ".runtime") },
    task: task("codex-1"),
    comments: [],
    artifacts: [],
    workflow: config.workflow,
    agents: config.agents,
    role: config.workflow.roles[0]!,
    runtimeConfig: { model: "configured-by-deployment" },
    tools: [],
  });
  const session = await runtime.start(prepared);
  const events = [];
  for await (const event of session.events) events.push(event.type);
  assert.deepEqual(events, ["run_started", "progress_updated", "artifact_created", "run_completed"]);
  assert.equal((await session.result).outcome, "approved");
  assert.equal(calls[0]?.cwd, root);
  assert.match(calls[0]?.prompt ?? "", /Use strict TypeScript/u);
  assert.match(calls[0]?.prompt ?? "", /Implement the task/u);

  let resumed = false;
  let cancelled = false;
  const resumeTransport: CodexTransport = {
    start: transport.start,
    async resume(existing): Promise<CodexTransportSession> { resumed = true; return existing; },
    async cancel(): Promise<void> { cancelled = true; },
  };
  const resumable = new CodexRuntime(resumeTransport);
  const initial = await resumable.start(await resumable.prepare(prepared.context));
  await resumable.resume(initial, { reason: "new feedback", comments: [], artifacts: [] });
  await resumable.cancel(initial);
  assert.equal(resumed, true);
  assert.equal(cancelled, true);
});
