import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryProvider,
  ExecutionCancelledError,
  ProviderClaimConflict,
  Scheduler,
} from "../src/index.ts";
import type {
  ConfiguredExecution,
  ExecutionEnvironment,
  ExecutionReport,
  ProviderAdapter,
  RepositoryConfiguration,
  RunningExecution,
  RuntimeExecutionRequest,
  ScheduleReport,
  Task,
  TaskExecutionService,
} from "../src/index.ts";

const repository = { id: "concurrency", url: "local://concurrency" };

function task(id: string, priority?: number): Task {
  return {
    id,
    title: id,
    description: "Run concurrently",
    acceptanceCriteria: [],
    status: "todo",
    labels: [],
    assignees: [],
    repository,
    ...(priority === undefined ? {} : { priority }),
  };
}

function configuration(global: number, byStatus: Readonly<Record<string, number>> = {}): RepositoryConfiguration {
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
    concurrency: { global, byStatus },
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
      turnMs: 1,
      stallMs: 1,
      cancellationMs: 1,
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
  readonly configured: string[] = [];
  readonly allocated: string[] = [];
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  readonly #results = new Map<string, Deferred<ExecutionReport>>();
  readonly #environmentFailures = new Map<string, Error>();
  readonly #startupFailures = new Map<string, Error>();
  readonly #startupGates = new Map<string, Deferred<void>>();
  readonly #cancellationGates = new Map<string, Deferred<void>>();

  constructor(configuration: RepositoryConfiguration) {
    this.configuration = configuration;
  }

  async withConfiguration<T>(item: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    this.configured.push(item.id);
    let used = false;
    const execution: ConfiguredExecution = {
      configuration: this.configuration,
      withEnvironment: async <TResult>(environmentWork: (environment: ExecutionEnvironment) => Promise<TResult>) => {
        if (used) throw new Error("configured execution is single-use");
        used = true;
        this.allocated.push(item.id);
        const environmentFailure = this.#environmentFailures.get(item.id);
        if (environmentFailure) throw environmentFailure;
        return environmentWork({
          configuration: this.configuration,
          start: async (request) => this.#start(request),
        });
      },
    };
    return work(execution);
  }

  finish(taskId: string): void {
    const result = this.#results.get(taskId);
    if (!result) throw new Error(`Task was not started: ${taskId}`);
    result.resolve({
      taskId,
      role: "implementation",
      executionId: `execution-${taskId}`,
      result: { outcome: "approved", summary: "done", comments: [], artifacts: [] },
    });
  }

  fail(taskId: string, error: Error): void {
    const result = this.#results.get(taskId);
    if (!result) throw new Error(`Task was not started: ${taskId}`);
    result.reject(error);
  }

  failEnvironment(taskId: string, error: Error): void {
    this.#environmentFailures.set(taskId, error);
  }

  failStartup(taskId: string, error: Error): void {
    this.#startupFailures.set(taskId, error);
  }

  holdStartup(taskId: string): Deferred<void> {
    const gate = deferred<void>();
    this.#startupGates.set(taskId, gate);
    return gate;
  }

  holdCancellation(taskId: string): Deferred<void> {
    const gate = deferred<void>();
    this.#cancellationGates.set(taskId, gate);
    return gate;
  }

  async #start(request: RuntimeExecutionRequest): Promise<RunningExecution> {
    const startupFailure = this.#startupFailures.get(request.task.id);
    if (startupFailure) throw startupFailure;
    await this.#startupGates.get(request.task.id)?.promise;
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
        this.cancelled.push(request.task.id);
        const gate = this.#cancellationGates.get(request.task.id);
        if (gate) return gate.promise;
        result.reject(new ExecutionCancelledError(reason));
      },
    };
  }
}

test("startup validates ordered repository configuration without allocating workspaces", async () => {
  const executions = new ControlledExecutions(configuration(2));
  const scheduler = new Scheduler(new InMemoryProvider([task("b"), task("a")]), executions);

  assert.deepEqual(await scheduler.startup(), { validatedTaskIds: ["a", "b"] });
  assert.deepEqual(executions.configured, ["a", "b"]);
  assert.deepEqual(executions.allocated, []);
  assert.deepEqual(executions.started, []);
});

test("poll overlaps workers within global capacity and preserves priority ordering", async () => {
  const provider = new InMemoryProvider([
    task("missing"),
    task("later", 2),
    task("same-b", 1),
    task("same-a", 1),
  ]);
  const executions = new ControlledExecutions(configuration(2));
  const scheduler = new Scheduler(provider, executions);

  const firstPoll = scheduler.poll();
  await waitFor(() => executions.started.length === 2);
  assert.deepEqual(executions.started, ["same-a", "same-b"]);
  assert.deepEqual(executions.allocated, ["same-a", "same-b"]);
  const [overlappingA, overlappingB] = await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.deepEqual(overlappingA.dispatchedTaskIds, []);
  assert.deepEqual(overlappingB.dispatchedTaskIds, []);

  executions.finish("same-a");
  executions.finish("same-b");
  assert.deepEqual((await firstPoll).map((report) => report.taskId), ["same-a", "same-b"]);

  const secondPoll = scheduler.poll();
  await waitFor(() => executions.started.length === 4);
  assert.deepEqual(executions.started, ["same-a", "same-b", "later", "missing"]);
  executions.finish("later");
  executions.finish("missing");
  assert.deepEqual((await secondPoll).map((report) => report.taskId), ["later", "missing"]);
});

test("running-status capacity is reserved before claim and held through synchronization", async () => {
  const delegate = new InMemoryProvider([task("first", 1), task("second", 2)]);
  const executions = new ControlledExecutions(configuration(3, { in_progress: 1 }));
  const synchronizationEntered = deferred<void>();
  const releaseSynchronization = deferred<void>();
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "beginExecution") return async (id: string, role: string, status: string) => {
        assert.equal(executions.allocated.includes(id), false);
        return target.beginExecution(id, role, status);
      };
      if (property === "completeExecution") return async (...args: Parameters<ProviderAdapter["completeExecution"]>) => {
        synchronizationEntered.resolve();
        await releaseSynchronization.promise;
        return target.completeExecution(...args);
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const scheduler = new Scheduler(provider, executions);

  const firstPoll = scheduler.poll();
  await waitFor(() => executions.started.length === 1);
  assert.deepEqual(executions.started, ["first"]);
  assert.deepEqual(executions.allocated, ["first"]);
  executions.finish("first");
  await synchronizationEntered.promise;
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.deepEqual(executions.allocated, ["first"]);

  releaseSynchronization.resolve();
  assert.equal((await firstPoll)[0]?.taskId, "first");
  const secondPoll = scheduler.poll();
  await waitFor(() => executions.started.includes("second"));
  executions.finish("second");
  releaseSynchronization.resolve();
  assert.equal((await secondPoll)[0]?.taskId, "second");
});

test("current-status capacity can disable admission without workspace allocation", async () => {
  const executions = new ControlledExecutions(configuration(3, { todo: 0 }));
  const scheduler = new Scheduler(new InMemoryProvider([task("disabled")]), executions);

  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, []);
  assert.deepEqual(executions.allocated, []);
  assert.deepEqual(executions.started, []);
});

test("environment and runtime startup failures release capacity for later ordered candidates", async () => {
  const provider = new InMemoryProvider([task("environment", 1), task("startup", 2), task("live", 3)]);
  const executions = new ControlledExecutions(configuration(1));
  executions.failEnvironment("environment", new Error("workspace allocation failed"));
  executions.failStartup("startup", new Error("runtime startup failed"));
  const scheduler = new Scheduler(provider, executions);

  const poll = scheduler.poll();
  await waitFor(() => executions.started.includes("live"));
  assert.deepEqual(executions.allocated, ["environment", "startup", "live"]);
  assert.deepEqual(executions.started, ["live"]);
  executions.finish("live");
  const reports = await poll;
  assert.match(reports.find((report) => report.taskId === "environment")?.error ?? "", /workspace allocation failed/u);
  assert.match(reports.find((report) => report.taskId === "startup")?.error ?? "", /runtime startup failed/u);
  assert.equal(reports.find((report) => report.taskId === "live")?.outcome, "completed");
});

test("poll arriving during a tick owns a later tick and never waits for the existing worker", async () => {
  const delegate = new InMemoryProvider([task("existing")]);
  const discoveryStarted = deferred<void>();
  const releaseDiscovery = deferred<void>();
  let discoveries = 0;
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "discoverTasks") return async (...args: Parameters<ProviderAdapter["discoverTasks"]>) => {
        discoveries += 1;
        if (discoveries === 1) {
          discoveryStarted.resolve();
          await releaseDiscovery.promise;
        }
        return target.discoverTasks(...args);
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const executions = new ControlledExecutions(configuration(1));
  const scheduler = new Scheduler(provider, executions);

  const tick = scheduler.tick();
  await discoveryStarted.promise;
  const poll = scheduler.poll();
  releaseDiscovery.resolve();
  assert.deepEqual((await tick).dispatchedTaskIds, ["existing"]);
  assert.deepEqual(await Promise.race([
    poll,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("poll waited for an existing worker")), 100)),
  ]), []);
  executions.finish("existing");
  await waitFor(async () => (await delegate.getTask("existing")).status === "done");
});

test("concurrent polls serialize dispatch only and never wait for each other's workers", async () => {
  const executions = new ControlledExecutions(configuration(1));
  const scheduler = new Scheduler(new InMemoryProvider([task("first-poll")]), executions);

  const firstPoll = scheduler.poll();
  await waitFor(() => executions.started.includes("first-poll"));
  const secondPoll = scheduler.poll();
  assert.deepEqual(await Promise.race([
    secondPoll,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("second poll waited for first poll's worker")), 100)),
  ]), []);
  executions.finish("first-poll");
  assert.equal((await firstPoll)[0]?.taskId, "first-poll");
});

test("failed completion synchronization is repaired exactly before redispatch", async () => {
  const delegate = new InMemoryProvider([task("sync-failure", 1), task("after-sync", 2)]);
  let failSynchronization = true;
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "completeExecution") return async (...args: Parameters<ProviderAdapter["completeExecution"]>) => {
        if (failSynchronization) {
          failSynchronization = false;
          throw new Error("provider synchronization failed");
        }
        return target.completeExecution(...args);
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const executions = new ControlledExecutions(configuration(1));
  const scheduler = new Scheduler(provider, executions);

  const first = scheduler.poll();
  await waitFor(() => executions.started.includes("sync-failure"));
  executions.finish("sync-failure");
  assert.match((await first)[0]?.error ?? "", /provider synchronization failed/u);
  assert.equal((await delegate.getTask("sync-failure")).status, "in_progress");
  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["after-sync"]);
  executions.finish("after-sync");
  await waitFor(async () => (await delegate.getTask("sync-failure")).status === "done");
  await waitFor(async () => (await delegate.getTask("after-sync")).status === "done");
});

test("claim conflicts and failed workers release capacity without leaking runtime starts", async () => {
  const delegate = new InMemoryProvider([task("conflict", 1), task("failure", 2), task("after", 3)]);
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "beginExecution") return async (id: string, role: string, status: string) => {
        if (id === "conflict") {
          throw new ProviderClaimConflict(id, { id: "other", role, startedAt: "2026-07-31T00:00:00.000Z" });
        }
        return target.beginExecution(id, role, status);
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const executions = new ControlledExecutions(configuration(1));
  const scheduler = new Scheduler(provider, executions);

  const firstPoll = scheduler.poll();
  await waitFor(() => executions.started.length === 1);
  assert.deepEqual(executions.started, ["failure"]);
  assert.equal(executions.allocated.includes("conflict"), false);
  executions.fail("failure", new Error("runtime failed"));
  const firstReports = await firstPoll;
  assert.equal(firstReports.find((report) => report.taskId === "failure")?.outcome, "failed");

  const secondPoll = scheduler.poll();
  await waitFor(() => executions.started.includes("after"));
  executions.finish("after");
  const reports: readonly ScheduleReport[] = await secondPoll;
  assert.equal(reports.at(-1)?.taskId, "after");
});

test("shutdown drains naturally, closes intake, and cancels live workers after the deadline", async () => {
  const naturalExecutions = new ControlledExecutions(configuration(1));
  const natural = new Scheduler(new InMemoryProvider([task("natural")]), naturalExecutions);
  assert.deepEqual((await natural.tick()).dispatchedTaskIds, ["natural"]);
  const naturalShutdown = natural.shutdown({ drainTimeoutMs: 100, cancellationTimeoutMs: 100 });
  naturalExecutions.finish("natural");
  assert.deepEqual(await naturalShutdown, { drained: true, cancelledTaskIds: [], remainingTaskIds: [] });
  assert.deepEqual((await natural.tick()).dispatchedTaskIds, []);

  const forcedExecutions = new ControlledExecutions(configuration(1));
  const forcedProvider = new InMemoryProvider([task("forced")]);
  const forced = new Scheduler(forcedProvider, forcedExecutions);
  assert.deepEqual((await forced.tick()).dispatchedTaskIds, ["forced"]);
  const forcedReport = await forced.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 100 });
  assert.deepEqual(forcedExecutions.cancelled, ["forced"]);
  assert.deepEqual(forcedReport, { drained: true, cancelledTaskIds: ["forced"], remainingTaskIds: [] });
  const forcedState = await forcedProvider.getExecutionState("forced");
  assert.deepEqual(forcedState.history.at(-1)?.failure, { kind: "shutdown", retryable: false });
  assert.deepEqual((await forced.tick()).dispatchedTaskIds, []);
});

test("shutdown remains bounded when cancellation and result channels do not cooperate", async () => {
  const provider = new InMemoryProvider([task("stuck")]);
  const executions = new ControlledExecutions(configuration(1));
  const cancellation = executions.holdCancellation("stuck");
  const scheduler = new Scheduler(provider, executions);

  assert.deepEqual((await scheduler.tick()).dispatchedTaskIds, ["stuck"]);
  const report = await Promise.race([
    scheduler.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 5 }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown exceeded its bound")), 100)),
  ]);
  assert.deepEqual(report, { drained: false, cancelledTaskIds: ["stuck"], remainingTaskIds: ["stuck"] });
  await waitFor(async () => (await provider.getExecutionState("stuck")).history.length === 1);
  assert.deepEqual((await provider.getExecutionState("stuck")).history[0]?.failure, {
    kind: "shutdown",
    retryable: false,
  });

  cancellation.reject(new Error("detached cancellation failed"));
  executions.fail("stuck", new ExecutionCancelledError("shutdown"));
  await waitFor(async () => (await provider.getTask("stuck")).status === "failed");
});

test("a runtime handle created after shutdown is quarantined and observed", async () => {
  const provider = new InMemoryProvider([task("late")]);
  const executions = new ControlledExecutions(configuration(1));
  const startup = executions.holdStartup("late");
  const cancellation = executions.holdCancellation("late");
  const scheduler = new Scheduler(provider, executions);

  const tick = scheduler.tick();
  await waitFor(() => executions.allocated.includes("late"));
  assert.deepEqual(await scheduler.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 0 }), {
    drained: false,
    cancelledTaskIds: ["late"],
    remainingTaskIds: ["late"],
  });
  startup.resolve();
  assert.deepEqual((await tick).dispatchedTaskIds, []);
  await waitFor(() => executions.cancelled.includes("late"));
  await waitFor(async () => (await provider.getTask("late")).status === "failed");
  cancellation.reject(new Error("late detached cancellation failed"));
  executions.fail("late", new ExecutionCancelledError("shutdown"));
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
