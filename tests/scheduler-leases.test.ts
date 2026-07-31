import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionCancelledError,
  InMemoryProvider,
  ProviderClaimConflict,
  processExecutionOwner,
  Scheduler,
} from "../src/index.ts";
import type {
  ActiveExecution,
  ConfiguredExecution,
  ExecutionEnvironment,
  ProviderAdapter,
  RepositoryConfiguration,
  RunningExecution,
  SchedulerTimerSource,
  Task,
  TaskExecutionService,
} from "../src/index.ts";
import { leaseClaim, leaseGuard } from "./lease-helpers.ts";

const repository = { id: "leases", url: "local://leases" } as const;

function task(id: string, metadata?: Readonly<Record<string, unknown>>, status = "ready"): Task {
  return { id, title: id, description: "work", acceptanceCriteria: [], status, labels: [], assignees: [], repository, metadata };
}

function configuration(): RepositoryConfiguration {
  return {
    repository,
    workflow: { instructions: "work", roles: [{ name: "implementation", instructions: "implement" }] },
    agents: "test", runtime: { name: "controlled", config: {} }, initialRole: "implementation",
    terminalOutcomes: ["completed"], runnableStatuses: ["ready", "running"], runningStatus: "running",
    completedStatus: "completed", failedStatus: "failed", blockedStatus: "blocked",
    service: { pollIntervalMs: 1 }, concurrency: { global: 1, byStatus: {} },
    retry: { maxFailedAttemptsPerRole: 1, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1, jitterRatio: 0, retryableFailureKinds: [] },
    timeouts: { startupMs: 1, providerMs: 1, runtimeStartMs: 1, turnMs: 1, stallMs: 1, cancellationMs: 1 },
    shutdown: { drainTimeoutMs: 1 }, workspace: { hooks: {}, hookTimeoutMs: 1 },
  };
}

class ManualTimers implements SchedulerTimerSource {
  readonly callbacks: Array<() => void> = [];
  set(_delayMs: number, callback: () => void): unknown { this.callbacks.push(callback); return callback; }
  clear(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  }
  fire(): void { this.callbacks.shift()?.(); }
}

class PendingExecutions implements TaskExecutionService {
  starts = 0;
  cancellations: string[] = [];
  readonly config = configuration();
  async reloadConfiguration() {
    return { status: "unchanged" as const, revision: "controlled", configuration: this.config };
  }
  async withConfiguration<T>(_task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    return work({
      configuration: this.config,
      withEnvironment: async (environmentWork) => environmentWork({
        configuration: this.config,
        start: async () => this.#running(),
      } satisfies ExecutionEnvironment),
    });
  }
  #running(): RunningExecution {
    this.starts += 1;
    let reject!: (error: unknown) => void;
    const result = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    return {
      executionId: "runtime", startedAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z", result,
      snapshot: () => { throw new Error("not needed"); },
      cancel: async (reason) => { this.cancellations.push(reason); reject(new ExecutionCancelledError(reason)); },
    };
  }
}

class CompletedExecutions implements TaskExecutionService {
  readonly config = configuration();
  async reloadConfiguration() {
    return { status: "unchanged" as const, revision: "controlled", configuration: this.config };
  }
  async withConfiguration<T>(taskValue: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    return work({
      configuration: this.config,
      withEnvironment: async (environmentWork) => environmentWork({
        configuration: this.config,
        start: async (request) => ({
          executionId: request.executionId,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          result: Promise.resolve({ taskId: taskValue.id, role: request.role.name, executionId: request.executionId,
            result: { outcome: "completed", summary: "done", comments: [], artifacts: [] } }),
          snapshot: () => { throw new Error("not needed"); }, cancel: async () => undefined,
        }),
      }),
    });
  }
}

test("leases preserve execution identity across expired takeover and reject stale terminal writes", async () => {
  const provider = new InMemoryProvider([task("takeover")], () => true, { now: () => new Date("2026-01-01T00:00:00.000Z") });
  const first = await provider.beginExecution("takeover", "implementation", "running", {
    ...leaseClaim(undefined, "owner-a"), expiresAt: "2026-01-01T00:00:10.000Z",
  });
  const taken = await provider.beginExecution("takeover", "ignored", "running", {
    ...leaseClaim(first, "owner-b"), observedAt: "2026-01-01T00:00:10.000Z", expiresAt: "2026-01-01T00:01:10.000Z",
  });
  assert.deepEqual(
    { id: taken.id, role: taken.role, startedAt: taken.startedAt, ownerId: taken.ownerId },
    { id: first.id, role: first.role, startedAt: first.startedAt, ownerId: "owner-b" },
  );
  await assert.rejects(provider.completeExecution("takeover", taken.id, leaseGuard(first), {
    record: { id: taken.id, role: taken.role, outcome: "completed", summary: "stale", finishedAt: "2026-01-01T00:00:05.000Z" },
    comments: [], artifacts: [], status: "completed",
  }), ProviderClaimConflict);
});

test("a live foreign lease prevents local execution allocation", async () => {
  const active: ActiveExecution = {
    id: "foreign-run", role: "implementation", startedAt: "2026-01-01T00:00:00.000Z",
    ownerId: "foreign", leaseExpiresAt: "2026-01-01T00:01:00.000Z",
  };
  const provider = new InMemoryProvider([task("foreign", { activeExecution: active }, "running")]);
  const executions = new PendingExecutions();
  const reports = await new Scheduler(provider, executions, {
    now: () => new Date("2026-01-01T00:00:30.000Z"), lease: { ownerId: "local" },
  }).poll();
  assert.deepEqual(reports, []);
  assert.equal(executions.starts, 0);
  assert.deepEqual(await provider.getExecutionState("foreign"), { active, history: [], nextRole: undefined });
});

test("a renewal ownership conflict cancels the running execution and suppresses stale provider failure", async () => {
  const delegate = new InMemoryProvider([task("loss")]);
  const timers = new ManualTimers();
  const executions = new PendingExecutions();
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "renewExecutionLease") return async (_id: string, _executionId: string, claim: Parameters<ProviderAdapter["renewExecutionLease"]>[2]) => {
        throw new ProviderClaimConflict("loss", {
          id: "loss:1", role: "implementation", startedAt: "2026-01-01T00:00:00.000Z",
          ownerId: "winner", leaseExpiresAt: claim.expiresAt,
        });
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const scheduler = new Scheduler(provider, executions, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    lease: { ownerId: "loser", durationMs: 60_000, renewIntervalMs: 20_000 }, timers,
  });
  const poll = scheduler.poll();
  await waitFor(() => executions.starts === 1);
  timers.fire();
  const [report] = await poll;
  assert.equal(report?.outcome, "failed");
  assert.deepEqual(executions.cancellations, ["lease_lost"]);
  const state = await delegate.getExecutionState("loss");
  assert.equal(state.history.length, 0);
  assert.ok(state.active);
  assert.equal(timers.callbacks.length, 0);
});

test("expired and legacy ineligible work is acquired and owner-guard cancelled without starting a runtime", async () => {
  for (const [id, active] of [
    ["expired-ineligible", {
      id: "expired-run", role: "implementation", startedAt: "2025-12-31T00:00:00.000Z",
      ownerId: "old-owner", leaseExpiresAt: "2026-01-01T00:00:00.000Z",
    }],
    ["legacy-ineligible", { id: "legacy-run", role: "implementation", startedAt: "2025-12-31T00:00:00.000Z" }],
  ] as const) {
    const provider = new InMemoryProvider([{ ...task(id, { activeExecution: active }, "running"), dispatchable: false }]);
    const executions = new PendingExecutions();
    const [report] = await new Scheduler(provider, executions, {
      now: () => new Date("2026-01-01T00:00:01.000Z"), lease: { ownerId: "new-owner" },
    }).poll();
    assert.match(report?.error ?? "", /provider marked task ineligible/u);
    assert.equal(executions.starts, 0);
    const state = await provider.getExecutionState(id);
    assert.equal(state.active, undefined);
    assert.equal(state.history[0]?.id, active.id);
    assert.equal(state.history[0]?.failure?.kind, "reconciliation");
  }
});

test("renewal is non-overlapping and retries a transient failure while the durable lease remains live", async () => {
  const delegate = new InMemoryProvider([task("transient")]);
  const timers = new ManualTimers();
  const executions = new PendingExecutions();
  let now = new Date("2026-01-01T00:00:00.000Z");
  let calls = 0;
  let rejectFirst!: (error: unknown) => void;
  const first = new Promise<ActiveExecution>((_resolve, reject) => { rejectFirst = reject; });
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "renewExecutionLease") return async (...args: Parameters<ProviderAdapter["renewExecutionLease"]>) => {
        calls += 1;
        if (calls === 1) return first;
        return target.renewExecutionLease(...args);
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const scheduler = new Scheduler(provider, executions, {
    now: () => now, lease: { ownerId: "worker", durationMs: 60_000, renewIntervalMs: 20_000 }, timers,
  });
  const poll = scheduler.poll();
  await waitFor(() => executions.starts === 1);
  now = new Date("2026-01-01T00:00:20.000Z");
  timers.fire();
  await waitFor(() => calls === 1);
  timers.fire();
  assert.equal(calls, 1);
  rejectFirst(new Error("temporary provider outage"));
  await waitFor(() => timers.callbacks.length === 1);
  now = new Date("2026-01-01T00:00:40.000Z");
  timers.fire();
  await waitFor(() => calls === 2);
  assert.equal((await delegate.getExecutionState("transient")).active?.leaseExpiresAt, "2026-01-01T00:01:40.000Z");
  await scheduler.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 10 });
  await poll;
});

test("default schedulers share the one process execution owner", async () => {
  const owners: string[] = [];
  for (const id of ["owner-a", "owner-b"]) {
    const delegate = new InMemoryProvider([task(id)]);
    const provider = new Proxy(delegate, {
      get(target, property, receiver) {
        if (property === "beginExecution") return async (...args: Parameters<ProviderAdapter["beginExecution"]>) => {
          owners.push(args[3].ownerId);
          return target.beginExecution(...args);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as ProviderAdapter;
    await new Scheduler(provider, new CompletedExecutions(), { now: () => new Date("2026-01-01T00:00:00.000Z") }).poll();
  }
  assert.deepEqual(owners, [processExecutionOwner.id, processExecutionOwner.id]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
