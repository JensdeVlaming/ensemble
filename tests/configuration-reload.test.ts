import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionEngine,
  HostSecretResolver,
  InMemoryProvider,
  RepositoryConfigLoader,
  RepositoryConfigurationManager,
  RuntimeRegistry,
  Scheduler,
} from "../src/index.ts";
import type {
  LoadedRepositoryConfiguration,
  RepositoryConfigSource,
  RepositoryConfiguration,
  RepositoryRef,
  RepositoryRevisionReader,
  Runtime,
  RuntimeContext,
  RuntimeResult,
  Task,
  TaskExecutionService,
  WorkspaceManager,
} from "../src/index.ts";

const repository: RepositoryRef = { id: "repository", url: "local://repository" };

function task(id = "task", selectedRepository = repository): Task {
  return {
    id,
    title: id,
    description: "",
    acceptanceCriteria: [],
    status: "todo",
    labels: [],
    assignees: [],
    repository: selectedRepository,
  };
}

function configuration(
  marker: string,
  pollIntervalMs = 10,
  drainTimeoutMs = 20,
  cancellationMs = 30,
  globalConcurrency = 1,
): RepositoryConfiguration {
  return {
    repository,
    workflow: { instructions: `workflow-${marker}`, roles: [{ name: "implementation", instructions: marker }] },
    agents: `agents-${marker}`,
    runtime: { name: "scripted", config: { marker } },
    initialRole: "implementation",
    terminalOutcomes: ["completed"],
    runnableStatuses: ["todo"],
    runningStatus: "running",
    completedStatus: "done",
    failedStatus: "failed",
    blockedStatus: "blocked",
    service: { pollIntervalMs },
    concurrency: { global: globalConcurrency, byStatus: {} },
    retry: {
      maxFailedAttemptsPerRole: 1,
      initialDelayMs: 1,
      maxDelayMs: 1,
      multiplier: 1,
      jitterRatio: 0,
      retryableFailureKinds: ["runtime"],
    },
    timeouts: { startupMs: 1, providerMs: 1, runtimeStartMs: 1, turnMs: 1, stallMs: 1, cancellationMs },
    shutdown: { drainTimeoutMs },
    workspace: { hooks: {}, hookTimeoutMs: 1 },
  };
}

interface SnapshotData {
  readonly config: string;
  readonly workflow: string;
  readonly agents: string;
  readonly roles: Readonly<Record<string, string>>;
}

class SequencedRevisionReader implements RepositoryRevisionReader {
  readonly snapshots: readonly SnapshotData[];
  #snapshot = 0;
  #active!: SnapshotData;

  constructor(snapshots: readonly SnapshotData[]) {
    this.snapshots = snapshots;
  }

  async list(): Promise<readonly string[]> {
    this.#active = this.snapshots[Math.min(this.#snapshot, this.snapshots.length - 1)]!;
    this.#snapshot += 1;
    return Object.keys(this.#active.roles);
  }

  async read(path: string): Promise<string> {
    if (path.endsWith("/.ensemble/config.yaml")) return this.#active.config;
    if (path.endsWith("/.ensemble/WORKFLOW.md")) return this.#active.workflow;
    if (path.endsWith("/AGENTS.md")) return this.#active.agents;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const role = this.#active.roles[name];
    if (role === undefined) throw new Error(`Missing role ${name}`);
    return role;
  }
}

class RemovedRoleRaceReader implements RepositoryRevisionReader {
  listCalls = 0;

  async list(): Promise<readonly string[]> {
    this.listCalls += 1;
    return this.listCalls === 1 ? ["implementation.md", "removed.md"] : ["implementation.md"];
  }

  async read(path: string): Promise<string> {
    if (path.endsWith("/removed.md")) throw new Error("removed after enumeration");
    if (path.endsWith("/.ensemble/config.yaml")) return "runtime:\n  name: scripted\n";
    if (path.endsWith("/.ensemble/WORKFLOW.md")) return "stable workflow";
    if (path.endsWith("/AGENTS.md")) return "stable agents";
    return "stable role";
  }
}

class SequencedSource implements RepositoryConfigSource {
  readonly values: Array<LoadedRepositoryConfiguration | Error | Promise<LoadedRepositoryConfiguration>>;
  calls = 0;

  constructor(values: Array<LoadedRepositoryConfiguration | Error | Promise<LoadedRepositoryConfiguration>>) {
    this.values = values;
  }

  async load(): Promise<RepositoryConfiguration> {
    return (await this.loadRevision()).configuration;
  }

  async loadRevision(): Promise<LoadedRepositoryConfiguration> {
    this.calls += 1;
    const next = this.values.shift();
    if (next === undefined) throw new Error("No configured revision");
    if (next instanceof Error) throw next;
    return next;
  }
}

function loaded(revision: string, value: RepositoryConfiguration): LoadedRepositoryConfiguration {
  return { revision, configuration: value };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("repository loading retries a changing full member set and installs only one stable revision", async () => {
  const yaml = "runtime:\n  name: scripted\ninitialRole: implementation\n";
  const reader = new SequencedRevisionReader([
    {
      config: yaml,
      workflow: "old workflow",
      agents: "old agents",
      roles: { "implementation.md": "old role", "obsolete.md": "old obsolete role" },
    },
    {
      config: yaml,
      workflow: "new workflow",
      agents: "literal $DO_NOT_SUBSTITUTE",
      roles: { "implementation.md": "new role", "reviewer.md": "new reviewer" },
    },
    {
      config: yaml,
      workflow: "new workflow",
      agents: "literal $DO_NOT_SUBSTITUTE",
      roles: { "implementation.md": "new role", "reviewer.md": "new reviewer" },
    },
  ]);
  const revision = await new RepositoryConfigLoader(reader, 3).loadRevision(repository, "/repository");

  assert.equal(revision.configuration.workflow.instructions, "new workflow");
  assert.equal(revision.configuration.agents, "literal $DO_NOT_SUBSTITUTE");
  assert.deepEqual(revision.configuration.workflow.roles.map((role) => role.name), ["implementation", "reviewer"]);
  assert.deepEqual(revision.configuration.workflow.roles.map((role) => role.instructions), ["new role", "new reviewer"]);
  assert.equal(Object.isFrozen(revision.configuration.workflow.roles), true);
  assert.match(revision.revision, /^[a-f0-9]{64}$/u);
});

test("repository loading rejects a member set that never becomes stable", async () => {
  const yaml = "runtime:\n  name: scripted\n";
  const snapshots = ["one", "two", "three"].map((marker): SnapshotData => ({
    config: yaml,
    workflow: marker,
    agents: marker,
    roles: { "implementation.md": marker },
  }));
  await assert.rejects(
    new RepositoryConfigLoader(new SequencedRevisionReader(snapshots), 3).loadRevision(repository, "/repository"),
    /changed during 3 consecutive snapshot reads/u,
  );
});

test("repository loading retries when a role disappears after enumeration", async () => {
  const reader = new RemovedRoleRaceReader();
  const revision = await new RepositoryConfigLoader(reader, 3).loadRevision(repository, "/repository");
  assert.equal(reader.listCalls, 3);
  assert.deepEqual(revision.configuration.workflow.roles.map((role) => role.name), ["implementation"]);
  assert.equal(revision.configuration.workflow.instructions, "stable workflow");
});

test("configuration manager coalesces reloads and atomically retains a redacted bounded last-known-good revision", async () => {
  const secrets = new HostSecretResolver({ CONFIG_SECRET: "very-private-value" });
  secrets.resolve("$CONFIG_SECRET", "provider.token");
  let release!: (value: LoadedRepositoryConfiguration) => void;
  const first = new Promise<LoadedRepositoryConfiguration>((resolve) => { release = resolve; });
  const source = new SequencedSource([
    first,
    loaded("a", configuration("ignored-same-revision")),
    new Error(`invalid very-private-value ${"x".repeat(200)}`),
    loaded("b", configuration("b", 40, 50, 60)),
  ]);
  const manager = new RepositoryConfigurationManager(source, repository, "/repository", {
    redact: (message) => secrets.redact(message),
    maxDiagnosticLength: 64,
  });

  await assert.rejects(manager.resolve(task()), /no valid configuration revision/u);
  const firstReload = manager.reload();
  const sharedReload = manager.reload();
  assert.equal(firstReload, sharedReload);
  release(loaded("a", configuration("a")));
  const installed = await firstReload;
  assert.equal(source.calls, 1);
  assert.equal(installed.status, "installed");
  assert.equal(Object.isFrozen(installed.configuration), true);
  assert.equal(Object.isFrozen(installed.configuration.runtime.config), true);

  const unchanged = await manager.reload();
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.configuration, installed.configuration);
  assert.equal(unchanged.configuration.workflow.instructions, "workflow-a");

  const retained = await manager.reload();
  assert.equal(retained.status, "retained");
  assert.equal(retained.configuration, installed.configuration);
  assert.equal(retained.diagnostic?.includes("very-private-value"), false);
  assert.match(retained.diagnostic ?? "", /\[REDACTED\]/u);
  assert.equal((retained.diagnostic ?? "").length, 64);
  assert.match(retained.diagnostic ?? "", /…$/u);

  const replacement = await manager.reload();
  assert.equal(replacement.status, "installed");
  assert.equal(replacement.configuration.workflow.instructions, "workflow-b");
  assert.notEqual(replacement.configuration, installed.configuration);
  assert.equal(await manager.resolve(task()), replacement.configuration);
  await assert.rejects(
    manager.resolve(task("foreign", { id: "foreign", url: "local://foreign" })),
    /does not own repository foreign/u,
  );
});

test("first-load failures redact before rejection and Scheduler hides unsafe reload errors", async () => {
  const secrets = new HostSecretResolver({ CONFIG_SECRET: "first-load-secret" });
  secrets.resolve("$CONFIG_SECRET", "provider.token");
  const manager = new RepositoryConfigurationManager(
    new SequencedSource([new Error("invalid first-load-secret")]),
    repository,
    "/repository",
    { redact: (message) => secrets.redact(message) },
  );
  await assert.rejects(manager.reload(), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message.includes("first-load-secret"), false);
    assert.match((error as Error).message, /\[REDACTED\]/u);
    return true;
  });
  await assert.rejects(
    new RepositoryConfigurationManager(
      new SequencedSource([loaded("", configuration("invalid-revision"))]),
      repository,
      "/repository",
    ).reload(),
    /invalid revision identifier/u,
  );

  const unsafeExecutions: TaskExecutionService = {
    reloadConfiguration: async () => { throw new Error("unsafe-provider-secret"); },
    withConfiguration: async <T>() => { throw new Error("not used") as never; },
  };
  const scheduler = new Scheduler(new InMemoryProvider([]), unsafeExecutions);
  await assert.rejects(scheduler.reloadConfiguration(), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message, "Configuration reload failed");
    return true;
  });
});

test("host secret resolution is exact, rejects missing values, and redacts every resolved value", () => {
  const secrets = new HostSecretResolver({ FIRST_TOKEN: "first-secret", SECOND_TOKEN: "secret" });
  assert.equal(secrets.resolve("$FIRST_TOKEN", "first"), "first-secret");
  assert.equal(secrets.resolve("$SECOND_TOKEN", "second"), "secret");
  assert.equal(secrets.redact("first-secret and secret"), "[REDACTED] and [REDACTED]");
  assert.throws(() => secrets.resolve("FIRST_TOKEN", "bad"), /environment secret reference/u);
  assert.throws(() => secrets.resolve("${FIRST_TOKEN}", "bad"), /environment secret reference/u);
  assert.throws(() => secrets.resolve("$MISSING", "missing"), /Missing or empty environment secret MISSING/u);
  assert.throws(
    () => new HostSecretResolver({ EMPTY: "   " }).resolve("$EMPTY", "empty"),
    /Missing or empty environment secret EMPTY/u,
  );
});

test("a production Scheduler keeps a running worker on revision A while a later dispatch captures revision B", async () => {
  const source = new SequencedSource([
    loaded("a", configuration("a", 11, 21, 31, 2)),
    loaded("b", configuration("b", 12, 22, 32, 2)),
  ]);
  const manager = new RepositoryConfigurationManager(source, repository, "/repository");
  const contexts: RuntimeContext[] = [];
  const pending = new Map<string, Deferred<RuntimeResult>>();
  const runtime: Runtime = {
    name: "scripted",
    prepare: async (context) => {
      contexts.push(context);
      return { id: context.task.id, context, payload: null };
    },
    start: async (prepared) => {
      const result = deferred<RuntimeResult>();
      pending.set(prepared.id, result);
      return { id: prepared.id, events: (async function* () {})(), result: result.promise };
    },
    resume: async (session) => session,
    cancel: async (session) => { pending.get(session.id)?.reject(new Error(`cancelled ${session.id}`)); },
  };
  const workspaces: WorkspaceManager = {
    restore: async () => undefined,
    create: async (item) => ({
      root: `/workspace/${item.id}`,
      repositoryPath: `/workspace/${item.id}/repository`,
      runtimePath: `/workspace/${item.id}/runtime`,
    }),
    cleanup: async () => undefined,
  };
  let includeSecond = false;
  const provider = new InMemoryProvider(
    [task("first"), task("second")],
    (candidate) => candidate.id === "first" || includeSecond,
  );
  const engine = new ExecutionEngine(new RuntimeRegistry([runtime]), workspaces, manager);
  const scheduler = new Scheduler(provider, engine);

  const firstReload = await scheduler.reloadConfiguration();
  assert.deepEqual(firstReload.operationalPolicy, {
    pollIntervalMs: 11,
    drainTimeoutMs: 21,
    cancellationTimeoutMs: 31,
  });
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["first"]);
  assert.equal(contexts[0]?.workflow.instructions, "workflow-a");
  assert.equal(pending.has("first"), true);

  const secondReload = await scheduler.reloadConfiguration();
  assert.equal(secondReload.status, "installed");
  includeSecond = true;
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["second"]);
  assert.equal(contexts[0]?.workflow.instructions, "workflow-a");
  assert.equal(contexts[1]?.workflow.instructions, "workflow-b");
  assert.equal(pending.has("first"), true);
  assert.equal(pending.has("second"), true);

  for (const result of pending.values()) {
    result.resolve({ outcome: "completed", summary: "done", comments: [], artifacts: [] });
  }
  const shutdown = await scheduler.shutdown({ drainTimeoutMs: 100, cancellationTimeoutMs: 100 });
  assert.equal(shutdown.drained, true);
  assert.equal(source.calls, 2);
});
