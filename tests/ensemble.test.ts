import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(created.root, join(base, "task-42"));
  assert.deepEqual(materialized, [created.repositoryPath]);
  assert.equal(await readFile(join(created.repositoryPath, "README.md"), "utf8"), "materialized");
  assert.equal((await stat(created.runtimePath)).isDirectory(), true);
  assert.deepEqual(await preserved.restore(task("Task / 42")), created);
  await preserved.cleanup(created);
  assert.equal((await stat(created.root)).isDirectory(), true);

  const disposable = new LocalWorkspaceManager(base, repositories, false);
  await disposable.cleanup(created);
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
    repository,
    workspace: { root, repositoryPath: root, runtimePath: join(root, ".runtime") },
    task: task("codex-1"),
    comments: [],
    artifacts: [],
    workflow: config.workflow,
    agents: config.agents,
    role: config.workflow.roles[0]!,
    runtimeConfig: { model: "configured-by-deployment" },
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
