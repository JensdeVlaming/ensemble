import assert from "node:assert/strict";
import test from "node:test";
import {
  OrchestratorService,
} from "../src/index.ts";
import type {
  OrchestratorScheduler,
  SchedulerShutdownOptions,
  SchedulerShutdownReport,
  SchedulerStartupReport,
  SchedulerTickReport,
  ServiceSignal,
  ServiceSignalSource,
  ServiceTimerSource,
} from "../src/index.ts";

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

class ControlledScheduler implements OrchestratorScheduler {
  readonly events: string[] = [];
  readonly shutdownOptions: SchedulerShutdownOptions[] = [];
  startupCalls = 0;
  tickCalls = 0;
  startupFailures = 0;
  startupGate?: Deferred<void>;
  readonly tickGates: Deferred<void>[] = [];

  async startup(): Promise<SchedulerStartupReport> {
    this.startupCalls += 1;
    this.events.push("startup");
    await this.startupGate?.promise;
    if (this.startupFailures > 0) {
      this.startupFailures -= 1;
      throw new Error("repository configuration invalid");
    }
    return { validatedTaskIds: [] };
  }

  async tick(): Promise<SchedulerTickReport> {
    this.tickCalls += 1;
    this.events.push("tick");
    await this.tickGates.shift()?.promise;
    return { dispatchedTaskIds: [`task-${this.tickCalls}`] };
  }

  async shutdown(options: SchedulerShutdownOptions): Promise<SchedulerShutdownReport> {
    this.events.push("shutdown");
    this.shutdownOptions.push(options);
    return { drained: true, cancelledTaskIds: [], remainingTaskIds: [] };
  }
}

class FakeSignals implements ServiceSignalSource {
  readonly listeners = new Map<ServiceSignal, Set<() => void>>();
  failOn?: ServiceSignal;

  addListener(signal: ServiceSignal, listener: () => void): void {
    if (this.failOn === signal) throw new Error(`cannot install ${signal}`);
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  removeListener(signal: ServiceSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: ServiceSignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

class FakeTimers implements ServiceTimerSource {
  readonly pending = new Map<object, () => void>();

  set(_delayMs: number, callback: () => void): unknown {
    const handle = {};
    this.pending.set(handle, callback);
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as object);
  }

  fireAll(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}

function registration(id: string, scheduler: OrchestratorScheduler) {
  return { id, scheduler, pollIntervalMs: 10, drainTimeoutMs: 20, cancellationTimeoutMs: 30 };
}

test("manual ticks startup-gate concurrent repositories, isolate failures, and recover", async () => {
  const first = new ControlledScheduler();
  const second = new ControlledScheduler();
  second.startupFailures = 1;
  const firstGate = deferred<void>();
  first.tickGates.push(firstGate);
  const service = new OrchestratorService([
    registration("z-repository", second),
    registration("a-repository", first),
  ], new FakeSignals(), new FakeTimers());

  const initial = service.tick();
  await waitFor(() => first.tickCalls === 1 && second.startupCalls === 1);
  assert.equal(second.tickCalls, 0);
  const overlapping = service.tick();
  firstGate.resolve();
  const expectedInitial = {
    repositories: [
      { repositoryId: "a-repository", outcome: "completed", dispatchedTaskIds: ["task-1"] },
      { repositoryId: "z-repository", outcome: "failed", dispatchedTaskIds: [], error: "repository configuration invalid" },
    ],
  } as const;
  assert.deepEqual(await initial, expectedInitial);
  assert.deepEqual(await overlapping, {
    repositories: [
      { repositoryId: "a-repository", outcome: "completed", dispatchedTaskIds: ["task-1"] },
      { repositoryId: "z-repository", outcome: "completed", dispatchedTaskIds: ["task-1"] },
    ],
  });
  assert.equal(first.tickCalls, 1);
  assert.equal(second.startupCalls, 2);

  assert.deepEqual(await service.tick(), {
    repositories: [
      { repositoryId: "a-repository", outcome: "completed", dispatchedTaskIds: ["task-2"] },
      { repositoryId: "z-repository", outcome: "completed", dispatchedTaskIds: ["task-2"] },
    ],
  });
  assert.deepEqual(first.events.slice(0, 2), ["startup", "tick"]);
  assert.deepEqual(second.events.slice(0, 3), ["startup", "startup", "tick"]);
  await service.shutdown();
  await assert.rejects(service.tick(), /while stopped/u);
});

test("completion-relative recurrence never overlaps or accumulates timer backlog", async () => {
  const scheduler = new ControlledScheduler();
  const initialGate = deferred<void>();
  const recurringGate = deferred<void>();
  scheduler.tickGates.push(initialGate, recurringGate);
  const timers = new FakeTimers();
  const service = new OrchestratorService([registration("repository", scheduler)], new FakeSignals(), timers);

  const started = service.start();
  await waitFor(() => scheduler.tickCalls === 1);
  assert.equal(timers.pending.size, 0);
  initialGate.resolve();
  await waitFor(() => timers.pending.size === 1);
  timers.fireAll();
  await waitFor(() => scheduler.tickCalls === 2);
  assert.equal(timers.pending.size, 0);
  recurringGate.resolve();
  await waitFor(() => timers.pending.size === 1);

  await service.shutdown();
  await started;
  assert.equal(timers.pending.size, 0);
});

test("failed startup retries on the next host-timed cycle rather than immediately", async () => {
  const scheduler = new ControlledScheduler();
  scheduler.startupFailures = 1;
  const timers = new FakeTimers();
  const service = new OrchestratorService([registration("repository", scheduler)], new FakeSignals(), timers);

  const started = service.start();
  await waitFor(() => service.state === "running" && timers.pending.size === 1);
  assert.equal(scheduler.startupCalls, 1);
  assert.equal(scheduler.tickCalls, 0);

  timers.fireAll();
  await waitFor(() => scheduler.tickCalls === 1 && timers.pending.size === 1);
  assert.equal(scheduler.startupCalls, 2);
  await service.shutdown();
  await started;
});

test("concurrent starts share signal ownership and a startup-racing signal shuts down once", async () => {
  const scheduler = new ControlledScheduler();
  scheduler.startupGate = deferred<void>();
  const signals = new FakeSignals();
  const service = new OrchestratorService([registration("repository", scheduler)], signals, new FakeTimers());

  const firstStart = service.start();
  const secondStart = service.start();
  assert.equal(firstStart, secondStart);
  assert.equal(signals.count(), 2);
  signals.emit("SIGTERM");
  await waitFor(() => scheduler.shutdownOptions.length === 1);
  await firstStart;
  assert.equal(service.state, "stopped");
  assert.equal(signals.count(), 0);
  assert.deepEqual(scheduler.shutdownOptions, [{ drainTimeoutMs: 20, cancellationTimeoutMs: 30 }]);
  scheduler.startupGate.resolve();
  assert.equal(service.shutdown(), service.shutdown());
  await assert.rejects(service.start(), /Cannot start service while stopped/u);
});

test("partial signal installation is rolled back without starting the service", async () => {
  const signals = new FakeSignals();
  signals.failOn = "SIGTERM";
  const service = new OrchestratorService([registration("repository", new ControlledScheduler())], signals, new FakeTimers());

  await assert.rejects(service.start(), /cannot install SIGTERM/u);
  assert.equal(service.state, "stopped");
  assert.equal(signals.count(), 0);
});

test("SIGINT uses the same idempotent graceful shutdown path", async () => {
  const scheduler = new ControlledScheduler();
  const signals = new FakeSignals();
  const service = new OrchestratorService([registration("repository", scheduler)], signals, new FakeTimers());

  const started = service.start();
  await waitFor(() => service.state === "running");
  signals.emit("SIGINT");
  await started;
  assert.equal(service.state, "stopped");
  assert.equal(scheduler.shutdownOptions.length, 1);
  assert.equal(signals.count(), 0);
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
