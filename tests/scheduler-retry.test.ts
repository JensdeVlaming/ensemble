import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionCancelledError,
  InMemoryProvider,
  Scheduler,
} from "../src/index.ts";
import type {
  ConfiguredExecution,
  ExecutionEnvironment,
  ExecutionRecord,
  FailureKind,
  ProviderAdapter,
  RepositoryConfiguration,
  RunningExecution,
  RuntimeExecutionRequest,
  RuntimeResult,
  Task,
  TaskExecutionService,
} from "../src/index.ts";

const repository = { id: "retry", url: "local://retry" } as const;

function task(id: string, metadata?: Readonly<Record<string, unknown>>): Task {
  return {
    id,
    title: id,
    description: "work",
    acceptanceCriteria: [],
    status: "todo",
    labels: [],
    assignees: [],
    repository,
    metadata,
  };
}

function configuration(options: {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitterRatio?: number;
  retryableKinds?: readonly FailureKind[];
  initialRole?: string;
  roles?: readonly string[];
  global?: number;
} = {}): RepositoryConfiguration {
  const roles = options.roles ?? ["implementation"];
  return {
    repository,
    workflow: { instructions: "work", roles: roles.map((name) => ({ name, instructions: name })) },
    agents: "test",
    runtime: { name: "controlled", config: {} },
    initialRole: options.initialRole ?? "implementation",
    terminalOutcomes: ["completed"],
    runnableStatuses: ["todo", "in_progress"],
    runningStatus: "in_progress",
    completedStatus: "done",
    failedStatus: "failed",
    blockedStatus: "blocked",
    service: { pollIntervalMs: 1 },
    concurrency: { global: options.global ?? 1, byStatus: {} },
    retry: {
      maxFailedAttemptsPerRole: options.maxAttempts ?? 4,
      initialDelayMs: options.initialDelayMs ?? 0,
      maxDelayMs: options.maxDelayMs ?? 0,
      multiplier: options.multiplier ?? 1,
      jitterRatio: options.jitterRatio ?? 0,
      retryableFailureKinds: options.retryableKinds ?? ["runtime"],
    },
    timeouts: { startupMs: 1, providerMs: 1, runtimeStartMs: 1, turnMs: 1, stallMs: 1, cancellationMs: 1 },
    shutdown: { drainTimeoutMs: 1 },
    workspace: { hooks: {}, hookTimeoutMs: 1 },
  };
}

type ExecutionOutcome = RuntimeResult | Error | "startup_error";

class ControlledExecutions implements TaskExecutionService {
  configuration: RepositoryConfiguration;
  readonly outcomes: ExecutionOutcome[];
  readonly started: string[] = [];

  constructor(configurationValue: RepositoryConfiguration, outcomes: readonly ExecutionOutcome[]) {
    this.configuration = configurationValue;
    this.outcomes = [...outcomes];
  }

  async withConfiguration<T>(_task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    const environment: ExecutionEnvironment = {
      configuration: this.configuration,
      start: async (request: RuntimeExecutionRequest): Promise<RunningExecution> => {
        this.started.push(request.task.id);
        const outcome = this.outcomes.shift() ?? completed("default");
        if (outcome === "startup_error") throw new Error("runtime startup failed");
        const result = outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve({
            taskId: request.task.id,
            role: request.role.name,
            executionId: request.executionId,
            result: outcome,
          });
        return {
          executionId: request.executionId,
          result,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          snapshot: () => ({
            executionId: request.executionId,
            taskId: request.task.id,
            role: request.role.name,
            runtimeSessionId: request.executionId,
            workspacePath: `/tmp/${request.task.id}`,
            state: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
          }),
          cancel: async () => undefined,
        };
      },
    };
    return work({
      configuration: this.configuration,
      withEnvironment: async (environmentWork) => environmentWork(environment),
    });
  }
}

test("durable due times gate ordinary ticks and reconstruct across Scheduler instances", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const config = configuration({ initialDelayMs: 1_000, maxDelayMs: 10_000, multiplier: 2, maxAttempts: 4 });
  const provider = new InMemoryProvider([task("reconstruct")]);
  const failed = new ControlledExecutions(config, [new Error("first failure")]);
  assert.equal((await new Scheduler(provider, failed, { now: () => now }).poll())[0]?.outcome, "failed");

  const first = (await provider.getExecutionState("reconstruct")).history[0];
  assert.deepEqual(first?.failure, {
    kind: "runtime",
    retryable: true,
    nextAttemptAt: "2026-01-01T00:00:01.000Z",
  });

  const recovered = new ControlledExecutions(configuration({
    initialDelayMs: 9_999,
    maxDelayMs: 9_999,
    multiplier: 9,
    maxAttempts: 4,
  }), [completed("recovered")]);
  now = new Date("2026-01-01T00:00:00.999Z");
  assert.deepEqual(await new Scheduler(provider, recovered, { now: () => now }).poll(), []);
  assert.deepEqual(recovered.started, []);

  now = new Date("2026-01-01T00:00:01.000Z");
  assert.equal((await new Scheduler(provider, recovered, { now: () => now }).poll())[0]?.outcome, "completed");
  assert.deepEqual(recovered.started, ["reconstruct"]);
  assert.equal(first?.failure?.nextAttemptAt, "2026-01-01T00:00:01.000Z");
});

test("retry number, exponential cap, configured classes, and max zero persist exact decisions", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const config = configuration({ initialDelayMs: 1_000, maxDelayMs: 2_500, multiplier: 2, maxAttempts: 4 });
  const provider = new InMemoryProvider([task("backoff")]);
  const executions = new ControlledExecutions(config, [
    new Error("one"), new Error("two"), new Error("three"), new Error("four"),
  ]);
  const scheduler = new Scheduler(provider, executions, { now: () => now });

  await scheduler.poll();
  now = new Date("2026-01-01T00:00:01.000Z");
  await scheduler.poll();
  now = new Date("2026-01-01T00:00:03.000Z");
  await scheduler.poll();
  now = new Date("2026-01-01T00:00:05.500Z");
  await scheduler.poll();
  const history = (await provider.getExecutionState("backoff")).history;
  assert.deepEqual(history.map((record) => record.failure), [
    { kind: "runtime", retryable: true, nextAttemptAt: "2026-01-01T00:00:01.000Z" },
    { kind: "runtime", retryable: true, nextAttemptAt: "2026-01-01T00:00:03.000Z" },
    { kind: "runtime", retryable: true, nextAttemptAt: "2026-01-01T00:00:05.500Z" },
    { kind: "runtime", retryable: false },
  ]);

  const zeroProvider = new InMemoryProvider([task("zero")]);
  const zeroExecutions = new ControlledExecutions(configuration({ maxAttempts: 0 }), [new Error("disabled")]);
  await new Scheduler(zeroProvider, zeroExecutions, { now: () => now }).poll();
  assert.deepEqual((await zeroProvider.getExecutionState("zero")).history[0]?.failure, {
    kind: "runtime",
    retryable: false,
  });
  assert.deepEqual(await new Scheduler(
    zeroProvider,
    new ControlledExecutions(configuration({ maxAttempts: 10 }), [completed("must not run")]),
    { now: () => now },
  ).poll(), []);
});

test("deterministic UTF-8 jitter and Date saturation produce pinned absolute times", async () => {
  const jitterProvider = new InMemoryProvider([task("jitter")]);
  const jitterConfig = configuration({ initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0.2, maxAttempts: 2 });
  await new Scheduler(
    jitterProvider,
    new ControlledExecutions(jitterConfig, [new Error("jitter")]),
    { now: () => new Date("2026-01-01T00:00:00.000Z") },
  ).poll();
  assert.equal(
    (await jitterProvider.getExecutionState("jitter")).history[0]?.failure?.nextAttemptAt,
    "2026-01-01T00:00:01.191Z",
  );

  const saturationProvider = new InMemoryProvider([task("saturation")]);
  const saturationConfig = configuration({
    initialDelayMs: Number.MAX_SAFE_INTEGER,
    maxDelayMs: Number.MAX_SAFE_INTEGER,
    multiplier: Number.MAX_SAFE_INTEGER,
    maxAttempts: 2,
  });
  await new Scheduler(
    saturationProvider,
    new ControlledExecutions(saturationConfig, [new Error("saturate")]),
    { now: () => new Date(8_640_000_000_000_000 - 1_000) },
  ).poll();
  assert.equal(
    (await saturationProvider.getExecutionState("saturation")).history[0]?.failure?.nextAttemptAt,
    "+275760-09-13T00:00:00.000Z",
  );

  const now = new Date("2026-01-01T00:00:00.000Z");
  const edgeConfig = configuration({ initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 1, maxAttempts: 2 });
  assert.equal((await failedRecord("edge-759289", edgeConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:00.000Z");
  assert.equal((await failedRecord("edge-1813380", edgeConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:02.000Z");
  assert.equal((await failedRecord("é", jitterConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:01.129Z");

  const roundingConfig = configuration({ initialDelayMs: 3, maxDelayMs: 3, jitterRatio: 0.5, maxAttempts: 2 });
  assert.equal((await failedRecord("round-4", roundingConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:00.003Z");
  assert.equal((await failedRecord("round-33", roundingConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:00.004Z");
  assert.equal((await failedRecord("round-19", roundingConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:00.003Z");
  assert.equal((await failedRecord("round-71", roundingConfig, now)).failure?.nextAttemptAt, "2026-01-01T00:00:00.002Z");

  assert.equal((await failedRecord(
    "zero-delay",
    configuration({ initialDelayMs: 0, maxDelayMs: 1_000, jitterRatio: 1, maxAttempts: 2 }),
    now,
  )).failure?.nextAttemptAt, "2026-01-01T00:00:00.000Z");

  const exponentRecord = await failedRecord(
    "saturating-exponent",
    configuration({
      initialDelayMs: 2_000,
      maxDelayMs: 2_500,
      multiplier: Number.MAX_SAFE_INTEGER,
      maxAttempts: 3,
    }),
    now,
    {
      executionHistory: [{
        id: "saturating-exponent:1",
        role: "implementation",
        outcome: "failed",
        summary: "prior",
        finishedAt: "2025-12-31T23:59:59.000Z",
        failure: { kind: "runtime", retryable: true, nextAttemptAt: "2026-01-01T00:00:00.000Z" },
      }],
    },
  );
  assert.equal(exponentRecord.failure?.nextAttemptAt, "2026-01-01T00:00:02.500Z");
});

test("current configuration may suppress but never promote a persisted retry decision", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const provider = new InMemoryProvider([task("suppressed")]);
  await new Scheduler(
    provider,
    new ControlledExecutions(configuration({ retryableKinds: ["runtime"] }), [new Error("retryable")]),
    { now: () => now },
  ).poll();
  const persisted = (await provider.getExecutionState("suppressed")).history[0]?.failure?.nextAttemptAt;

  const suppressed = new ControlledExecutions(configuration({ retryableKinds: [] }), [completed("not yet")]);
  assert.deepEqual(await new Scheduler(provider, suppressed, { now: () => now }).poll(), []);
  assert.deepEqual(suppressed.started, []);
  assert.equal((await provider.getExecutionState("suppressed")).history[0]?.failure?.nextAttemptAt, persisted);

  const enabled = new ControlledExecutions(configuration({ retryableKinds: ["runtime"] }), [completed("now")]);
  assert.equal((await new Scheduler(provider, enabled, { now: () => now }).poll())[0]?.outcome, "completed");

  const fixedProvider = new InMemoryProvider([task("fixed")]);
  await new Scheduler(
    fixedProvider,
    new ControlledExecutions(configuration({ retryableKinds: [] }), [new Error("fixed")]),
    { now: () => now },
  ).poll();
  const promoted = new ControlledExecutions(configuration({ retryableKinds: ["runtime"] }), [completed("must not run")]);
  assert.deepEqual(await new Scheduler(fixedProvider, promoted, { now: () => now }).poll(), []);
  assert.deepEqual(promoted.started, []);
});

test("claimed failures use stage and typed-cancellation classes under configured policy", async () => {
  const cases: readonly {
    id: string;
    expected: FailureKind;
    retryable: boolean;
    executions: ControlledExecutions;
    provider?: (delegate: InMemoryProvider) => ProviderAdapter;
  }[] = [
    {
      id: "provider",
      expected: "provider",
      retryable: true,
      executions: new ControlledExecutions(configuration({ retryableKinds: ["provider"] }), [completed("unused")]),
      provider: (delegate) => proxyProvider(delegate, {
        getComments: async () => { throw new Error("provider comments failed"); },
      }),
    },
    {
      id: "configuration",
      expected: "configuration",
      retryable: true,
      executions: new ControlledExecutions(
        configuration({ initialRole: "missing", roles: ["implementation"], retryableKinds: ["configuration"] }),
        [completed("unused")],
      ),
    },
    {
      id: "startup",
      expected: "startup",
      retryable: true,
      executions: new ControlledExecutions(configuration({ retryableKinds: ["startup"] }), ["startup_error"]),
    },
    {
      id: "runtime",
      expected: "runtime",
      retryable: true,
      executions: new ControlledExecutions(configuration({ retryableKinds: ["runtime"] }), [new Error("runtime failed")]),
    },
    {
      id: "runtime-disabled",
      expected: "runtime",
      retryable: false,
      executions: new ControlledExecutions(configuration({ retryableKinds: [] }), [new Error("runtime disabled")]),
    },
    {
      id: "timeout",
      expected: "timeout",
      retryable: true,
      executions: new ControlledExecutions(
        configuration({ retryableKinds: ["timeout"] }),
        [new ExecutionCancelledError("timeout")],
      ),
    },
    {
      id: "stalled",
      expected: "stalled",
      retryable: true,
      executions: new ControlledExecutions(
        configuration({ retryableKinds: ["stalled"] }),
        [new ExecutionCancelledError("stalled")],
      ),
    },
  ];

  for (const item of cases) {
    const delegate = new InMemoryProvider([task(item.id)]);
    await new Scheduler(item.provider?.(delegate) ?? delegate, item.executions, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }).poll();
    assert.equal((await delegate.getExecutionState(item.id)).history[0]?.failure?.kind, item.expected);
    assert.equal((await delegate.getExecutionState(item.id)).history[0]?.failure?.retryable, item.retryable);
  }
});

test("failed failure synchronization retries the exact record before redispatch", async () => {
  const delegate = new InMemoryProvider([task("repair")]);
  const attempted: ExecutionRecord[] = [];
  let failFirst = true;
  let claimCalls = 0;
  const provider = proxyProvider(delegate, {
    beginExecution: async (id, role, status, lease) => {
      claimCalls += 1;
      return delegate.beginExecution(id, role, status, lease);
    },
    failExecution: async (id, executionId, lease, record, status, comment) => {
      attempted.push(structuredClone(record));
      if (failFirst) {
        failFirst = false;
        throw new Error("failure mutation unavailable");
      }
      await delegate.failExecution(id, executionId, lease, record, status, comment);
    },
  });
  const executions = new ControlledExecutions(configuration({ maxAttempts: 3 }), [
    new Error("runtime failure"), completed("recovered"),
  ]);
  const scheduler = new Scheduler(provider, executions, { now: () => new Date("2026-01-01T00:00:00.000Z") });

  assert.match((await scheduler.poll())[0]?.error ?? "", /failure mutation unavailable/u);
  assert.ok((await delegate.getExecutionState("repair")).active);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await waitFor(async () => (await delegate.getExecutionState("repair")).history.length === 1);
  assert.equal(attempted.length, 2);
  assert.deepEqual(attempted[1], attempted[0]);
  assert.deepEqual((await delegate.getExecutionState("repair")).history[0], {
    ...attempted[0]!,
    blockingRequest: undefined,
  });

  executions.configuration = configuration({ maxAttempts: 3, retryableKinds: [] });
  assert.deepEqual(await scheduler.poll(), []);
  assert.equal(claimCalls, 1);
  executions.configuration = configuration({ maxAttempts: 3, global: 0 });
  assert.deepEqual(await scheduler.poll(), []);
  assert.equal(claimCalls, 1);
  executions.configuration = configuration({ maxAttempts: 3 });
  assert.equal((await scheduler.poll())[0]?.outcome, "completed");
  assert.equal(executions.started.length, 2);
  assert.equal(claimCalls, 2);
});

test("unreadable and conflicting synchronization state remain quarantined", async () => {
  const delegate = new InMemoryProvider([task("conflict")]);
  let failCalls = 0;
  let refreshMode: "omitted" | "unreadable" | "current" = "omitted";
  let conflict = false;
  const provider = proxyProvider(delegate, {
    failExecution: async () => {
      failCalls += 1;
      throw new Error("cannot persist");
    },
    refreshTasks: async (ids) => {
      if (refreshMode === "omitted") return new Map();
      if (refreshMode === "unreadable") {
        return new Map(ids.map((id) => [id, { kind: "unreadable" as const, error: "rate limited" }]));
      }
      return delegate.refreshTasks(ids);
    },
    getExecutionState: async (id) => {
      const state = await delegate.getExecutionState(id);
      if (!conflict || !state.active) return state;
      return {
        history: [{
          id: state.active.id,
          role: state.active.role,
          outcome: "failed",
          summary: "different payload",
          finishedAt: "2026-01-01T00:00:00.000Z",
          failure: { kind: "runtime", retryable: false },
        }],
      };
    },
  });
  const executions = new ControlledExecutions(configuration(), [new Error("original"), completed("must not run")]);
  const scheduler = new Scheduler(provider, executions, { now: () => new Date("2026-01-01T00:00:00.000Z") });

  await scheduler.poll();
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.equal(failCalls, 1);
  refreshMode = "unreadable";
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.equal(failCalls, 1);
  refreshMode = "current";
  conflict = true;
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.equal(failCalls, 1);
  assert.deepEqual(executions.started, ["conflict"]);
});

test("authoritative missing state settles synchronization without provider mutation", async () => {
  const delegate = new InMemoryProvider([task("missing-sync")]);
  let missing = false;
  let completionCalls = 0;
  const provider = proxyProvider(delegate, {
    discoverTasks: async (query) => missing ? [] : delegate.discoverTasks(query),
    refreshTasks: async (ids) => missing
      ? new Map(ids.map((id) => [id, { kind: "missing" as const }]))
      : delegate.refreshTasks(ids),
    completeExecution: async () => {
      completionCalls += 1;
      throw new Error("completion unavailable");
    },
  });
  const scheduler = new Scheduler(
    provider,
    new ControlledExecutions(configuration(), [completed("locally complete")]),
  );
  await scheduler.poll();
  missing = true;
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.equal(completionCalls, 1);
  assert.deepEqual(await scheduler.shutdown({ drainTimeoutMs: 1, cancellationTimeoutMs: 1 }), {
    drained: true,
    cancelledTaskIds: [],
    remainingTaskIds: [],
  });
});

test("an already-written completion record still repairs remaining provider side effects", async () => {
  const delegate = new InMemoryProvider([task("completion-saga")]);
  let completionCalls = 0;
  const provider = proxyProvider(delegate, {
    completeExecution: async (id, executionId, lease, completion) => {
      completionCalls += 1;
      if (completionCalls === 1) {
        await delegate.completeExecution(id, executionId, lease, {
          ...completion,
          comments: [],
          artifacts: [],
          status: "in_progress",
        });
        throw new Error("response lost before side effects");
      }
      for (const comment of completion.comments) await delegate.createComment(id, comment);
      for (const artifact of completion.artifacts) await delegate.uploadArtifact(id, artifact);
      await delegate.updateStatus(id, completion.status);
    },
  });
  const result: RuntimeResult = {
    outcome: "completed",
    summary: "finished",
    comments: ["side effect"],
    artifacts: [{ type: "report", url: "https://example.test/report" }],
  };
  const scheduler = new Scheduler(provider, new ControlledExecutions(configuration(), [result]));
  assert.match((await scheduler.poll())[0]?.error ?? "", /response lost before side effects/u);
  assert.equal((await delegate.getTask("completion-saga")).status, "in_progress");
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await waitFor(async () => (await delegate.getTask("completion-saga")).status === "done");
  assert.equal(completionCalls, 2);
  assert.deepEqual((await delegate.getComments("completion-saga")).map((comment) => comment.body), ["side effect", "finished"]);
  assert.deepEqual(await delegate.getArtifacts("completion-saga"), result.artifacts);
  assert.equal((await delegate.getExecutionState("completion-saga")).history.length, 1);
});

test("a conflicting completion record cannot clear synchronization quarantine", async () => {
  const delegate = new InMemoryProvider([task("completion-conflict")]);
  let conflict = false;
  let completionCalls = 0;
  const provider = proxyProvider(delegate, {
    completeExecution: async () => {
      completionCalls += 1;
      throw new Error("cannot persist completion");
    },
    getExecutionState: async (id) => {
      const state = await delegate.getExecutionState(id);
      if (!conflict || !state.active) return state;
      return {
        history: [{
          id: state.active.id,
          role: state.active.role,
          outcome: "completed",
          summary: "conflicting completion",
          finishedAt: "2026-01-01T00:00:00.000Z",
        }],
      };
    },
  });
  const executions = new ControlledExecutions(configuration(), [completed("original completion")]);
  const scheduler = new Scheduler(provider, executions, { now: () => new Date("2026-01-01T00:00:00.000Z") });
  await scheduler.poll();
  conflict = true;
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.equal(completionCalls, 1);
  assert.deepEqual(executions.started, ["completion-conflict"]);
});

test("graceful shutdown bounds and releases unresolved provider synchronization keepers", async () => {
  const delegate = new InMemoryProvider([task("pending-sync")]);
  const provider = proxyProvider(delegate, {
    completeExecution: async () => { throw new Error("provider remains unavailable"); },
  });
  const scheduler = new Scheduler(
    provider,
    new ControlledExecutions(configuration(), [completed("finished locally")]),
  );
  assert.match((await scheduler.poll())[0]?.error ?? "", /provider remains unavailable/u);
  assert.deepEqual(await scheduler.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 1 }), {
    drained: true,
    cancelledTaskIds: [],
    remainingTaskIds: [],
  });
});

test("legacy failures remain readable and malformed present FailureDetail is rejected", async () => {
  const legacy = new InMemoryProvider([task("legacy", {
    executionHistory: [{
      id: "legacy:1",
      role: "implementation",
      outcome: "failed",
      summary: "old Ensemble record",
      finishedAt: "2025-01-01T00:00:00.000Z",
    }],
  })]);
  assert.equal((await legacy.getExecutionState("legacy")).history[0]?.failure, undefined);
  const executions = new ControlledExecutions(configuration(), [completed("must not run")]);
  assert.deepEqual(await new Scheduler(legacy, executions).poll(), []);
  assert.deepEqual(executions.started, []);

  for (const failure of [
    { kind: "unknown", retryable: false },
    { kind: "runtime", retryable: true },
    { kind: "runtime", retryable: false, nextAttemptAt: "2026-01-01T00:00:00.000Z" },
    { kind: "runtime", retryable: true, nextAttemptAt: "not-a-date" },
    { kind: "runtime", retryable: true, nextAttemptAt: "2026-01-01" },
  ]) {
    const malformed = new InMemoryProvider([task("malformed", {
      executionHistory: [{
        id: "malformed:1",
        role: "implementation",
        outcome: "failed",
        summary: "bad",
        finishedAt: "2025-01-01T00:00:00.000Z",
        failure,
      }],
    })]);
    await assert.rejects(malformed.getExecutionState("malformed"), /Invalid execution record/u);
  }
});

function completed(summary: string): RuntimeResult {
  return { outcome: "completed", summary, comments: [], artifacts: [] };
}

async function failedRecord(
  id: string,
  config: RepositoryConfiguration,
  now: Date,
  metadata?: Readonly<Record<string, unknown>>,
): Promise<ExecutionRecord> {
  const provider = new InMemoryProvider([task(id, metadata)]);
  await new Scheduler(
    provider,
    new ControlledExecutions(config, [new Error("failed")]),
    { now: () => now },
  ).poll();
  return (await provider.getExecutionState(id)).history.at(-1)!;
}

function proxyProvider(delegate: InMemoryProvider, overrides: Partial<ProviderAdapter>): ProviderAdapter {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property) as unknown;
      if (typeof override === "function") return override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
