import { ExecutionCancelledError } from "../execution/engine.ts";
import type { ConfiguredExecution, RunningExecution, TaskExecutionService } from "../execution/engine.ts";
import { ProviderClaimConflict } from "../providers/provider.ts";
import type { ExecutionRecord, ProviderAdapter, ProviderExecutionState } from "../providers/provider.ts";
import type { RepositoryConfiguration, RuntimeResult, Task } from "../domain/model.ts";

export interface ScheduleReport {
  readonly taskId: string;
  readonly outcome: "completed" | "advanced" | "failed";
  readonly role: string;
  readonly nextRole?: string;
  readonly error?: string;
}

export interface SchedulerTickReport {
  readonly dispatchedTaskIds: readonly string[];
}

export interface SchedulerStartupReport {
  readonly validatedTaskIds: readonly string[];
}

export interface SchedulerShutdownOptions {
  readonly drainTimeoutMs: number;
  readonly cancellationTimeoutMs: number;
}

export interface SchedulerShutdownReport {
  readonly drained: boolean;
  readonly cancelledTaskIds: readonly string[];
  readonly remainingTaskIds: readonly string[];
}

interface WorkerReservation {
  readonly taskId: string;
  readonly configuration: RepositoryConfiguration;
  status: string;
  executionId?: string;
  role?: string;
  running?: RunningExecution;
}

interface DispatchEntry {
  readonly taskId: string;
  readonly dispatched: boolean;
  readonly completion: Promise<ScheduleReport | undefined>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export class Scheduler {
  readonly #workers = new Map<string, WorkerReservation>();
  readonly #idleWaiters = new Set<() => void>();
  #tickInProgress?: Promise<readonly DispatchEntry[]>;
  #pollDispatchTail: Promise<void> = Promise.resolve();
  #accepting = true;
  #shutdown?: Promise<SchedulerShutdownReport>;
  readonly provider: ProviderAdapter;
  readonly executions: TaskExecutionService;

  constructor(provider: ProviderAdapter, executions: TaskExecutionService) {
    this.provider = provider;
    this.executions = executions;
  }

  async startup(): Promise<SchedulerStartupReport> {
    if (!this.#accepting) throw new Error("Scheduler intake is closed");
    const discovered = [...await this.provider.discoverTasks({ scope: "workflow_candidates" })].sort(compareCandidates);
    const validated: string[] = [];
    for (const candidate of discovered) {
      if (!this.#accepting) throw new Error("Scheduler intake is closed");
      const task = await this.provider.getTask(candidate.id);
      await this.executions.withConfiguration(task, async () => undefined);
      validated.push(task.id);
    }
    await this.#reconcileForStartup();
    return Object.freeze({ validatedTaskIds: Object.freeze(validated) });
  }

  async tick(): Promise<SchedulerTickReport> {
    if (!this.#accepting) return Object.freeze({ dispatchedTaskIds: Object.freeze([]) });
    const entries = await this.#beginTick();
    return Object.freeze({
      dispatchedTaskIds: Object.freeze(entries.filter((entry) => entry.dispatched).map((entry) => entry.taskId)),
    });
  }

  poll(): Promise<readonly ScheduleReport[]> {
    if (!this.#accepting) return Promise.resolve(Object.freeze([]));
    const predecessor = this.#pollDispatchTail;
    let releaseDispatch!: () => void;
    this.#pollDispatchTail = new Promise((resolve) => { releaseDispatch = resolve; });
    return (async () => {
      await predecessor;
      let entries: readonly DispatchEntry[];
      try {
        if (this.#tickInProgress) await this.#tickInProgress;
        entries = await this.#beginTick();
      } finally {
        releaseDispatch();
      }
      const reports = await Promise.all(entries.map((entry) => entry.completion));
      return reports.filter((report): report is ScheduleReport => report !== undefined);
    })();
  }

  #beginTick(): Promise<readonly DispatchEntry[]> {
    if (!this.#accepting) return Promise.resolve(Object.freeze([]));
    if (this.#tickInProgress) return this.#tickInProgress;
    const tick = this.#dispatchTick();
    this.#tickInProgress = tick;
    void tick.finally(() => {
      if (this.#tickInProgress === tick) this.#tickInProgress = undefined;
      this.#notifyIdle();
    }).catch(() => undefined);
    return tick;
  }

  async #dispatchTick(): Promise<readonly DispatchEntry[]> {
    if (!this.#accepting) return Object.freeze([]);
    const tasks = await this.provider.discoverTasks({ scope: "workflow_candidates" });
    const entries: DispatchEntry[] = [];
    for (const discovered of [...tasks].sort(compareCandidates)) {
      if (!this.#accepting) break;
      if (this.#workers.has(discovered.id)) continue;
      const entry = await this.#dispatchCandidate(discovered);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async #dispatchCandidate(discovered: Task): Promise<DispatchEntry | undefined> {
    let task: Task;
    try {
      task = await this.provider.getTask(discovered.id);
    } catch (error) {
      return settledEntry(discovered.id, failureReport(discovered.id, "unknown", error));
    }
    if (!this.#accepting) return undefined;
    if (this.#workers.has(task.id)) return undefined;
    try {
      return await this.executions.withConfiguration(task, async (execution) => {
        if (!this.#accepting || this.#workers.has(task.id) || !this.#hasCapacity(execution.configuration, task.status)) return undefined;
        return this.#reserveAndDispatch(task, execution);
      });
    } catch (error) {
      return settledEntry(task.id, failureReport(task.id, "unknown", error));
    }
  }

  #hasCapacity(configuration: RepositoryConfiguration, status: string): boolean {
    if (configuration.concurrency.global === 0 || this.#workers.size >= configuration.concurrency.global) return false;
    if (this.#statusFull(configuration, status)) return false;
    return status === configuration.runningStatus || !this.#statusFull(configuration, configuration.runningStatus);
  }

  #statusFull(configuration: RepositoryConfiguration, status: string): boolean {
    const limit = configuration.concurrency.byStatus[status];
    if (limit === undefined) return false;
    let count = 0;
    for (const worker of this.#workers.values()) if (worker.status === status) count += 1;
    return count >= limit;
  }

  async #reserveAndDispatch(task: Task, execution: ConfiguredExecution): Promise<DispatchEntry> {
    const completion = deferred<ScheduleReport | undefined>();
    const reservation: WorkerReservation = {
      taskId: task.id,
      configuration: execution.configuration,
      status: task.status,
    };
    this.#workers.set(task.id, reservation);
    const entry = (dispatched: boolean): DispatchEntry => ({ taskId: task.id, dispatched, completion: completion.promise });
    let executionId: string | undefined;
    let roleName = "unknown";
    try {
      const state = await this.provider.getExecutionState(task.id);
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      if (task.dispatchable === false) {
        this.#release(reservation);
        completion.resolve(undefined);
        return entry(false);
      }
      const selectedRole = selectRole(state, execution.configuration);
      roleName = selectedRole;
      if (!state.active && !isEligible(task, state, selectedRole, execution.configuration)) {
        this.#release(reservation);
        completion.resolve(undefined);
        return entry(false);
      }

      const active = state.active ?? await this.provider.beginExecution(task.id, selectedRole, execution.configuration.runningStatus);
      executionId = active.id;
      roleName = active.role;
      reservation.executionId = active.id;
      reservation.role = active.role;
      if (!state.active) reservation.status = execution.configuration.runningStatus;
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      const role = execution.configuration.workflow.roles.find((candidate) => candidate.name === roleName);
      if (!role) throw new Error(`Unknown role '${roleName}' for task ${task.id}`);
      const [comments, artifacts] = await Promise.all([
        this.provider.getComments(task.id),
        this.provider.getArtifacts(task.id),
      ]);
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      const running = await execution.withEnvironment((environment) => environment.start({
        task,
        role,
        comments,
        artifacts,
        executionId: active.id,
      }));
      reservation.running = running;
      if (!this.#accepting) {
        void running.cancel("shutdown").catch(() => undefined);
      }
      void this.#completeWorker(task, reservation, roleName, active.id, running).then(
        completion.resolve,
        (error: unknown) => {
          this.#release(reservation);
          completion.resolve(failureReport(task.id, roleName, error));
        },
      );
      return entry(this.#accepting);
    } catch (error) {
      if (error instanceof ProviderClaimConflict) {
        this.#release(reservation);
        completion.resolve(undefined);
        return entry(false);
      }
      const report = await this.#recordFailure(task, execution.configuration, roleName, executionId, error);
      this.#release(reservation);
      completion.resolve(report);
      return entry(false);
    }
  }

  async #completeWorker(
    task: Task,
    reservation: WorkerReservation,
    roleName: string,
    executionId: string,
    running: RunningExecution,
  ): Promise<ScheduleReport> {
    try {
      const report = await running.result;
      await this.#synchronize(task, reservation.configuration, roleName, executionId, report.result);
      const terminal = reservation.configuration.terminalOutcomes.includes(report.result.outcome);
      return { taskId: task.id, outcome: terminal ? "completed" : "advanced", role: roleName, nextRole: report.result.nextRole };
    } catch (error) {
      if (error instanceof ExecutionCancelledError && error.reason === "shutdown") {
        return this.#recordCancellation(task.id, reservation.configuration, roleName, executionId);
      }
      return this.#recordFailure(task, reservation.configuration, roleName, executionId, error);
    } finally {
      this.#release(reservation);
    }
  }

  async #recordFailure(
    task: Task,
    configuration: RepositoryConfiguration,
    roleName: string,
    executionId: string | undefined,
    error: unknown,
  ): Promise<ScheduleReport> {
    let reportError = error;
    if (executionId) {
      const message = errorMessage(error);
      try {
        await this.provider.failExecution(task.id, executionId, {
          id: executionId,
          role: roleName,
          outcome: "failed",
          summary: message,
          finishedAt: new Date().toISOString(),
        }, configuration.failedStatus, `Ensemble execution failed: ${message}`);
      } catch (synchronizationError) {
        reportError = synchronizationError;
      }
    }
    return failureReport(task.id, roleName, reportError);
  }

  #release(reservation: WorkerReservation): void {
    if (this.#workers.get(reservation.taskId) === reservation) this.#workers.delete(reservation.taskId);
    this.#notifyIdle();
  }

  async shutdown(options: SchedulerShutdownOptions): Promise<SchedulerShutdownReport> {
    this.#accepting = false;
    this.#shutdown ??= this.#performShutdown(options);
    return this.#shutdown;
  }

  async #performShutdown(options: SchedulerShutdownOptions): Promise<SchedulerShutdownReport> {
    if (this.#workers.size === 0 && this.#tickInProgress === undefined) {
      return Object.freeze({ drained: true, cancelledTaskIds: Object.freeze([]), remainingTaskIds: Object.freeze([]) });
    }
    const drained = await waitWithin(this.#waitForIdle(), options.drainTimeoutMs);
    if (drained) {
      return Object.freeze({ drained: true, cancelledTaskIds: Object.freeze([]), remainingTaskIds: Object.freeze([]) });
    }

    const cancelledTaskIds = [...this.#workers.values()]
      .filter((reservation) => reservation.executionId !== undefined)
      .map((reservation) => reservation.taskId)
      .sort();
    for (const reservation of this.#workers.values()) {
      if (reservation.executionId && reservation.role) {
        void this.#recordCancellation(
          reservation.taskId,
          reservation.configuration,
          reservation.role,
          reservation.executionId,
        );
      }
      if (reservation.running) {
        void reservation.running.cancel("shutdown").catch(() => undefined);
        void reservation.running.result.catch(() => undefined);
      }
    }
    await waitWithin(this.#waitForIdle(), options.cancellationTimeoutMs);
    return Object.freeze({
      drained: this.#workers.size === 0 && this.#tickInProgress === undefined,
      cancelledTaskIds: Object.freeze(cancelledTaskIds),
      remainingTaskIds: Object.freeze([...this.#workers.keys()].sort()),
    });
  }

  #waitForIdle(): Promise<void> {
    if (this.#workers.size === 0 && this.#tickInProgress === undefined) return Promise.resolve();
    return new Promise((resolve) => { this.#idleWaiters.add(resolve); });
  }

  #notifyIdle(): void {
    if (this.#workers.size !== 0 || this.#tickInProgress !== undefined) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async #reconcileForStartup(): Promise<void> {
    const liveTaskIds = [...this.#workers.keys()].sort();
    if (liveTaskIds.length === 0) return;
    await this.provider.refreshTasks(liveTaskIds);
  }

  async #stopReservation(
    task: Task,
    reservation: WorkerReservation,
    roleName: string,
    executionId: string | undefined,
    completion: Deferred<ScheduleReport | undefined>,
    entry: (dispatched: boolean) => DispatchEntry,
  ): Promise<DispatchEntry> {
    const report = executionId
      ? await this.#recordCancellation(task.id, reservation.configuration, roleName, executionId)
      : undefined;
    this.#release(reservation);
    completion.resolve(report);
    return entry(false);
  }

  async #recordCancellation(
    taskId: string,
    configuration: RepositoryConfiguration,
    roleName: string,
    executionId: string,
  ): Promise<ScheduleReport> {
    const summary = "Ensemble execution cancelled during shutdown";
    try {
      await this.provider.cancelExecution(taskId, executionId, {
        record: {
          id: executionId,
          role: roleName,
          outcome: "cancelled",
          summary,
          finishedAt: new Date().toISOString(),
          failure: { kind: "shutdown", retryable: false },
        },
        status: configuration.failedStatus,
        comment: summary,
      });
      return { taskId, outcome: "failed", role: roleName, error: summary };
    } catch (error) {
      return failureReport(taskId, roleName, error);
    }
  }

  async #synchronize(task: Task, config: RepositoryConfiguration, role: string, executionId: string, result: RuntimeResult): Promise<void> {
    const terminal = config.terminalOutcomes.includes(result.outcome);
    if (!terminal && !result.nextRole) throw new Error(`Non-terminal outcome '${result.outcome}' requires nextRole`);
    if (result.nextRole && !config.workflow.roles.some((candidate) => candidate.name === result.nextRole)) {
      throw new Error(`Runtime requested unknown next role: ${result.nextRole}`);
    }
    await this.provider.completeExecution(task.id, executionId, {
      record: {
        id: executionId,
        role,
        outcome: result.outcome,
        summary: result.summary,
        nextRole: terminal ? undefined : result.nextRole,
        finishedAt: new Date().toISOString(),
      },
      comments: [...result.comments, result.summary],
      artifacts: result.artifacts,
      status: terminal ? config.completedStatus : config.runningStatus,
    });
  }
}

function compareCandidates(left: Task, right: Task): number {
  if (left.priority !== undefined || right.priority !== undefined) {
    if (left.priority === undefined) return 1;
    if (right.priority === undefined) return -1;
    const priority = left.priority - right.priority;
    if (priority !== 0) return priority;
  }
  return left.id.localeCompare(right.id);
}

function selectRole(state: ProviderExecutionState, config: RepositoryConfiguration): string {
  if (state.active) return state.active.role;
  if (state.nextRole) return state.nextRole;
  const latestFailure = [...state.history].reverse().find((record) => record.outcome === "failed");
  return latestFailure?.role ?? config.initialRole;
}

function isEligible(task: Task, state: ProviderExecutionState, role: string, config: RepositoryConfiguration): boolean {
  if (task.dispatchable === false || task.blockers?.some((blocker) => !blocker.resolved)) return false;
  const latest = state.history.at(-1);
  const retrying = latest?.outcome === "failed";
  if (!retrying) return config.runnableStatuses.includes(task.status);
  const failures = state.history.filter((record: ExecutionRecord) => record.role === role && record.outcome === "failed").length;
  return failures < config.retry.maxFailedAttemptsPerRole;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function settledEntry(taskId: string, report: ScheduleReport): DispatchEntry {
  return { taskId, dispatched: false, completion: Promise.resolve(report) };
}

function failureReport(taskId: string, role: string, error: unknown): ScheduleReport {
  return { taskId, outcome: "failed", role, error: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  if (milliseconds === 0) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { finish(false); }, milliseconds);
    void promise.then(() => { finish(true); });
  });
}
