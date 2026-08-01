import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionCancelledError,
  InMemoryProvider,
  Scheduler,
} from "../src/index.ts";
import type {
  ConfiguredExecution,
  ExecutionCancellation,
  ExecutionEnvironment,
  ExecutionReport,
  ProviderAdapter,
  RepositoryConfiguration,
  RunningExecution,
  RuntimeExecutionRequest,
  Task,
  TaskExecutionService,
  TaskQuery,
  TaskRefreshResult,
} from "../src/index.ts";

const repository = { id: "reconciliation", url: "local://reconciliation" };

function task(id: string, priority?: number): Task {
  return {
    id,
    title: id,
    description: "Reconcile active work",
    acceptanceCriteria: [],
    status: "todo",
    labels: [],
    assignees: [],
    dispatchable: true,
    repository,
    ...(priority === undefined ? {} : { priority }),
  };
}

function configuration(global = 10, cancellationMs = 5): RepositoryConfiguration {
  return {
    repository,
    workflow: { instructions: "Run", roles: [{ name: "implementation", instructions: "Implement" }] },
    agents: "Test",
    runtime: { name: "controlled", config: {} },
    initialRole: "implementation",
    terminalOutcomes: ["approved"],
    runnableStatuses: ["todo", "in_progress"],
    runningStatus: "in_progress",
    completedStatus: "done",
    failedStatus: "failed",
    blockedStatus: "blocked",
    service: { pollIntervalMs: 1 },
    concurrency: { global, byStatus: {} },
    retry: {
      maxFailedAttemptsPerRole: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 1,
      jitterRatio: 0,
      retryableFailureKinds: ["runtime"],
    },
    timeouts: {
      startupMs: 1,
      providerMs: 1,
      runtimeStartMs: 1,
      turnMs: 315_360_000_000,
      stallMs: 315_360_000_000,
      cancellationMs,
    },
    shutdown: { drainTimeoutMs: 1 },
    workspace: { hooks: {}, hookTimeoutMs: 1 },
  };
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

class ControlledExecutions implements TaskExecutionService {
  readonly configuration: RepositoryConfiguration;
  readonly allocated: string[] = [];
  readonly started: string[] = [];
  readonly cancelled: Array<{ readonly taskId: string; readonly reason: string }> = [];
  readonly #results = new Map<string, Deferred<ExecutionReport>>();
  readonly #cancellationGates = new Map<string, Deferred<void>>();

  constructor(config: RepositoryConfiguration) {
    this.configuration = config;
  }

  async reloadConfiguration() {
    return { status: "unchanged" as const, revision: "controlled", configuration: this.configuration };
  }

  async withConfiguration<T>(item: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    return work({
      configuration: this.configuration,
      withEnvironment: async <TResult>(environmentWork: (environment: ExecutionEnvironment) => Promise<TResult>) => {
        this.allocated.push(item.id);
        return environmentWork({
          configuration: this.configuration,
          start: async (request) => this.#start(request),
        });
      },
    });
  }

  finish(taskId: string): void {
    this.#result(taskId).resolve({
      kind: "completed",
      taskId,
      role: "implementation",
      executionId: `execution-${taskId}`,
      result: { outcome: "approved", summary: "done", comments: [], artifacts: [] },
    });
  }

  holdCancellation(taskId: string): Deferred<void> {
    const gate = deferred<void>();
    this.#cancellationGates.set(taskId, gate);
    return gate;
  }

  #start(request: RuntimeExecutionRequest): RunningExecution {
    this.started.push(request.task.id);
    const result = deferred<ExecutionReport>();
    this.#results.set(request.task.id, result);
    return {
      executionId: request.executionId,
      result: result.promise,
      startedAt: "2026-07-31T00:00:00.000Z",
      lastActivityAt: "2026-07-31T00:00:00.000Z",
      snapshot: () => ({
        executionId: request.executionId,
        taskId: request.task.id,
        role: request.role.name,
        runtimeSessionId: `runtime-${request.task.id}`,
        workspacePath: `/workspaces/${request.task.id}`,
        state: "running",
        startedAt: "2026-07-31T00:00:00.000Z",
        lastActivityAt: "2026-07-31T00:00:00.000Z",
      }),
      cancel: async (reason) => {
        this.cancelled.push({ taskId: request.task.id, reason });
        const gate = this.#cancellationGates.get(request.task.id);
        if (gate) return gate.promise;
        result.reject(new ExecutionCancelledError(reason));
      },
    };
  }

  #result(taskId: string): Deferred<ExecutionReport> {
    const result = this.#results.get(taskId);
    if (!result) throw new Error(`Task was not started: ${taskId}`);
    return result;
  }
}

class ProviderControl {
  readonly delegate: InMemoryProvider;
  readonly hidden = new Set<string>();
  readonly cancellationCalls: Array<{
    readonly taskId: string;
    readonly executionId: string;
    readonly cancellation: ExecutionCancellation;
  }> = [];
  refresh?: (ids: readonly string[]) => Promise<ReadonlyMap<string, TaskRefreshResult>>;
  readonly cancellationGates: Deferred<void>[] = [];

  constructor(tasks: readonly Task[]) {
    this.delegate = new InMemoryProvider(tasks);
  }

  adapter(): ProviderAdapter {
    const control = this;
    return new Proxy(this.delegate, {
      get(target, property, receiver) {
        if (property === "discoverTasks") return async (query: TaskQuery) =>
          (await target.discoverTasks(query)).filter((item) => !control.hidden.has(item.id));
        if (property === "refreshTasks") return async (ids: readonly string[]) =>
          control.refresh ? control.refresh(ids) : target.refreshTasks(ids);
        if (property === "cancelExecution") return async (
          taskId: string, executionId: string,
          lease: Parameters<ProviderAdapter["cancelExecution"]>[2], cancellation: ExecutionCancellation,
        ) => {
          control.cancellationCalls.push({ taskId, executionId, cancellation });
          const gate = control.cancellationGates.shift();
          if (gate) await gate.promise;
          return target.cancelExecution(taskId, executionId, lease, cancellation);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as ProviderAdapter;
  }
}

test("failed, omitted, and unreadable refreshes never imply deletion", async () => {
  const control = new ProviderControl([task("a"), task("b")]);
  const executions = new ControlledExecutions(configuration(2));
  const scheduler = new Scheduler(control.adapter(), executions);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["a", "b"]);

  control.refresh = async () => new Map([["a", { kind: "unreadable", error: "rate limited" }]]);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.deepEqual(executions.cancelled, []);
  assert.ok((await control.delegate.getExecutionState("a")).active);
  assert.ok((await control.delegate.getExecutionState("b")).active);

  control.refresh = async () => { throw new Error("provider refresh failed"); };
  await assert.rejects(scheduler.tick(), /provider refresh failed/u);
  assert.deepEqual(executions.cancelled, []);
  executions.finish("a");
  executions.finish("b");
  await waitFor(async () => (await control.delegate.getTask("a")).status === "done");
});

test("portable blocker, routing, dispatchability, and status changes cancel idempotently", async () => {
  const ids = ["blocked", "routed", "unmanaged", "terminal"];
  const control = new ProviderControl(ids.map((id) => task(id)));
  const executions = new ControlledExecutions(configuration(4));
  const scheduler = new Scheduler(control.adapter(), executions);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, [...ids].sort());

  control.refresh = async () => {
    const current = await Promise.all(ids.map((id) => control.delegate.getTask(id)));
    return new Map<string, TaskRefreshResult>([
      ["blocked", { kind: "current", task: { ...current[0]!, blockers: [{ id: "dependency", resolved: false }] } }],
      ["routed", { kind: "current", task: { ...current[1]!, repository: { id: "other", url: "local://other" } } }],
      ["unmanaged", { kind: "current", task: { ...current[2]!, dispatchable: false } }],
      ["terminal", { kind: "current", task: { ...current[3]!, status: "done" } }],
    ]);
  };
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await waitFor(() => executions.cancelled.length === 4);
  await waitFor(async () => (await control.delegate.getExecutionState("terminal")).history.length === 1);

  assert.deepEqual(executions.cancelled.map((item) => item.reason), Array(4).fill("reconciliation"));
  for (const id of ids) {
    const state = await control.delegate.getExecutionState(id);
    assert.equal(state.history.length, 1);
    assert.deepEqual(state.history[0]?.failure, { kind: "reconciliation", retryable: false });
  }
  assert.match((await control.delegate.getExecutionState("blocked")).history[0]?.summary ?? "", /unresolved blocker/u);
  assert.match((await control.delegate.getExecutionState("routed")).history[0]?.summary ?? "", /repository route/u);
  assert.match((await control.delegate.getExecutionState("unmanaged")).history[0]?.summary ?? "", /provider marked task ineligible/u);
  assert.match((await control.delegate.getExecutionState("terminal")).history[0]?.summary ?? "", /not runnable/u);
  assert.equal((await control.delegate.getTask("terminal")).status, "done");
});

test("authoritative missing state cancels locally without requiring a provider mutation", async () => {
  const control = new ProviderControl([task("missing")]);
  const executions = new ControlledExecutions(configuration(1));
  const scheduler = new Scheduler(control.adapter(), executions);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["missing"]);

  control.hidden.add("missing");
  control.refresh = async () => new Map([["missing", { kind: "missing" }]]);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await waitFor(() => executions.cancelled.length === 1);
  assert.deepEqual(control.cancellationCalls, []);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
});

test("bounded capacity release keeps incomplete cancellation quarantined until repaired", async () => {
  const control = new ProviderControl([task("old", 1), task("after", 2)]);
  const executions = new ControlledExecutions(configuration(1, 5));
  const localCancellation = executions.holdCancellation("old");
  const providerCancellation = deferred<void>();
  control.cancellationGates.push(providerCancellation);
  const scheduler = new Scheduler(control.adapter(), executions);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["old"]);

  control.refresh = async (ids) => {
    const results = new Map<string, TaskRefreshResult>();
    for (const id of ids) {
      const current = await control.delegate.getTask(id);
      results.set(id, { kind: "current", task: id === "old" ? { ...current, status: "blocked" } : current });
    }
    return results;
  };
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await waitFor(() => control.cancellationCalls.length === 1 && executions.cancelled.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["after"]);
  assert.equal(executions.started.filter((id) => id === "old").length, 1);
  executions.finish("after");
  await waitFor(async () => (await control.delegate.getTask("after")).status === "done");

  providerCancellation.reject(new Error("first cancellation synchronization failed"));
  localCancellation.resolve();
  await waitFor(() => control.cancellationCalls.length === 1);
  control.refresh = async (ids) => new Map(await Promise.all(ids.map(async (id) => [
    id,
    { kind: "current", task: { ...await control.delegate.getTask(id), status: "todo", dispatchable: true } },
  ] as const)));

  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await waitFor(() => control.cancellationCalls.length === 2);
  assert.equal(control.cancellationCalls[1]?.cancellation.status, "todo");
  await waitFor(async () => (await control.delegate.getExecutionState("old")).history.length === 1);
  assert.deepEqual((await control.delegate.getExecutionState("old")).history[0]?.failure, {
    kind: "reconciliation",
    retryable: false,
  });

  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["old"]);
  assert.equal(executions.started.filter((id) => id === "old").length, 2);
  executions.finish("old");
});

test("graceful shutdown reports a non-capacity reconciliation quarantine as remaining", async () => {
  const control = new ProviderControl([task("quarantined")]);
  const executions = new ControlledExecutions(configuration(1, 2));
  const localCancellation = executions.holdCancellation("quarantined");
  const providerCancellation = deferred<void>();
  control.cancellationGates.push(providerCancellation);
  const scheduler = new Scheduler(control.adapter(), executions);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["quarantined"]);

  control.refresh = async () => new Map([["quarantined", {
    kind: "current",
    task: { ...await control.delegate.getTask("quarantined"), status: "blocked" },
  }]]);
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(await scheduler.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 2 }), {
    drained: false,
    cancelledTaskIds: ["quarantined"],
    remainingTaskIds: ["quarantined"],
  });
  providerCancellation.reject(new Error("provider remains unavailable"));
  localCancellation.resolve();
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
