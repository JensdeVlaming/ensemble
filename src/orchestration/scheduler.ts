import { ExecutionCancelledError } from "../execution/engine.ts";
import type { ConfiguredExecution, RunningExecution, TaskExecutionService } from "../execution/engine.ts";
import { ProviderClaimConflict } from "../providers/provider.ts";
import type { ExecutionRecord, ProviderAdapter, ProviderExecutionState, TaskRefreshResult } from "../providers/provider.ts";
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
  readonly completion: Deferred<ScheduleReport | undefined>;
  status: string;
  executionId?: string;
  role?: string;
  running?: RunningExecution;
  reconciliation?: ReconciliationQuarantine;
}

interface ReconciliationQuarantine {
  readonly taskId: string;
  readonly executionId: string;
  readonly role: string;
  readonly configuration: RepositoryConfiguration;
  readonly reservation: WorkerReservation;
  readonly summary: string;
  readonly settled: Deferred<void>;
  durableSettled: boolean;
  localSettled: boolean;
  providerAttempt?: Promise<void>;
  lastReport?: ScheduleReport;
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
  readonly #quarantines = new Map<string, ReconciliationQuarantine>();
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
    await this.#reconcileActiveWork();
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
    const reconciledTaskIds = await this.#reconcileActiveWork();
    if (!this.#accepting) return Object.freeze([]);
    const tasks = await this.provider.discoverTasks({ scope: "workflow_candidates" });
    const entries: DispatchEntry[] = [];
    for (const discovered of [...tasks].sort(compareCandidates)) {
      if (!this.#accepting) break;
      if (reconciledTaskIds.has(discovered.id) || this.#workers.has(discovered.id) || this.#quarantines.has(discovered.id)) continue;
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
    if (this.#workers.has(task.id) || this.#quarantines.has(task.id)) return undefined;
    try {
      return await this.executions.withConfiguration(task, async (execution) => {
        if (!this.#accepting || this.#workers.has(task.id) || this.#quarantines.has(task.id)
          || !this.#hasCapacity(execution.configuration, task.status)) return undefined;
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
      completion,
      status: task.status,
    };
    this.#workers.set(task.id, reservation);
    const entry = (dispatched: boolean): DispatchEntry => ({ taskId: task.id, dispatched, completion: completion.promise });
    let executionId: string | undefined;
    let roleName = "unknown";
    try {
      const state = await this.provider.getExecutionState(task.id);
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      const selectedRole = selectRole(state, execution.configuration);
      roleName = selectedRole;
      if (state.active) {
        executionId = state.active.id;
        roleName = state.active.role;
        reservation.executionId = state.active.id;
        reservation.role = state.active.role;
        const reason = reconciliationReason(task, execution.configuration);
        if (reason) {
          this.#beginReconciliationCancellation(reservation, reason, task.status, true);
          return entry(false);
        }
      }
      if (task.dispatchable === false) {
        this.#release(reservation);
        completion.resolve(undefined);
        return entry(false);
      }
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
        (report) => {
          if (!reservation.reconciliation) completion.resolve(report);
        },
        (error: unknown) => {
          if (!reservation.reconciliation) {
            this.#release(reservation);
            completion.resolve(failureReport(task.id, roleName, error));
          }
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
      if (reservation.reconciliation) return reconciliationReport(reservation.reconciliation);
      await this.#synchronize(task, reservation.configuration, roleName, executionId, report.result);
      const terminal = reservation.configuration.terminalOutcomes.includes(report.result.outcome);
      return { taskId: task.id, outcome: terminal ? "completed" : "advanced", role: roleName, nextRole: report.result.nextRole };
    } catch (error) {
      if (reservation.reconciliation) return reconciliationReport(reservation.reconciliation);
      if (error instanceof ExecutionCancelledError && error.reason === "shutdown") {
        return this.#recordCancellation(task.id, reservation.configuration, roleName, executionId);
      }
      return this.#recordFailure(task, reservation.configuration, roleName, executionId, error);
    } finally {
      if (!reservation.reconciliation) this.#release(reservation);
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
    if (this.#workers.size === 0 && this.#quarantines.size === 0 && this.#tickInProgress === undefined) {
      return Object.freeze({ drained: true, cancelledTaskIds: Object.freeze([]), remainingTaskIds: Object.freeze([]) });
    }
    const drained = await waitWithin(this.#waitForIdle(), options.drainTimeoutMs);
    if (drained) {
      return Object.freeze({ drained: true, cancelledTaskIds: Object.freeze([]), remainingTaskIds: Object.freeze([]) });
    }

    const cancelledTaskIds = [...new Set([
      ...[...this.#workers.values()]
        .filter((reservation) => reservation.executionId !== undefined)
        .map((reservation) => reservation.taskId),
      ...this.#quarantines.keys(),
    ])].sort();
    for (const reservation of this.#workers.values()) {
      if (!reservation.reconciliation && reservation.executionId && reservation.role) {
        void this.#recordCancellation(
          reservation.taskId,
          reservation.configuration,
          reservation.role,
          reservation.executionId,
        );
      }
      if (!reservation.reconciliation && reservation.running) {
        void reservation.running.cancel("shutdown").catch(() => undefined);
        void reservation.running.result.catch(() => undefined);
      }
    }
    for (const quarantine of this.#quarantines.values()) {
      if (!quarantine.reservation.running) continue;
      void quarantine.reservation.running.cancel("shutdown").catch(() => undefined);
      void quarantine.reservation.running.result.catch(() => undefined);
    }
    await waitWithin(this.#waitForIdle(), options.cancellationTimeoutMs);
    return Object.freeze({
      drained: this.#workers.size === 0 && this.#quarantines.size === 0 && this.#tickInProgress === undefined,
      cancelledTaskIds: Object.freeze(cancelledTaskIds),
      remainingTaskIds: Object.freeze([...new Set([...this.#workers.keys(), ...this.#quarantines.keys()])].sort()),
    });
  }

  #waitForIdle(): Promise<void> {
    if (this.#workers.size === 0 && this.#quarantines.size === 0 && this.#tickInProgress === undefined) return Promise.resolve();
    return new Promise((resolve) => { this.#idleWaiters.add(resolve); });
  }

  #notifyIdle(): void {
    if (this.#workers.size !== 0 || this.#quarantines.size !== 0 || this.#tickInProgress !== undefined) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async #reconcileActiveWork(): Promise<ReadonlySet<string>> {
    const taskIds = [...new Set([...this.#workers.keys(), ...this.#quarantines.keys()])].sort();
    const excluded = new Set(this.#quarantines.keys());
    if (taskIds.length === 0) return excluded;
    const refreshed = await this.provider.refreshTasks(taskIds);
    for (const taskId of taskIds) {
      const result = refreshed.get(taskId);
      if (!result || result.kind === "unreadable") continue;
      const quarantine = this.#quarantines.get(taskId);
      if (quarantine) {
        this.#reconcileQuarantine(quarantine, result);
        continue;
      }
      const reservation = this.#workers.get(taskId);
      if (!reservation || reservation.reconciliation) continue;
      if (result.kind === "missing") {
        this.#beginReconciliationCancellation(
          reservation,
          "Ensemble execution cancelled during reconciliation: task is authoritatively missing",
          undefined,
          false,
        );
        excluded.add(taskId);
        continue;
      }
      reservation.status = result.task.status;
      const reason = reconciliationReason(result.task, reservation.configuration);
      if (reason) {
        this.#beginReconciliationCancellation(reservation, reason, result.task.status, true);
        excluded.add(taskId);
      }
    }
    return excluded;
  }

  #reconcileQuarantine(
    quarantine: ReconciliationQuarantine,
    result: Exclude<TaskRefreshResult, { readonly kind: "unreadable" }>,
  ): void {
    if (result.kind === "missing") {
      quarantine.durableSettled = true;
      this.#maybeClearQuarantine(quarantine);
      return;
    }
    void this.#confirmOrRetryCancellation(quarantine, result.task.status).catch(() => undefined);
  }

  async #confirmOrRetryCancellation(quarantine: ReconciliationQuarantine, status: string): Promise<void> {
    if (quarantine.durableSettled) {
      this.#maybeClearQuarantine(quarantine);
      return;
    }
    if (quarantine.providerAttempt) return;
    try {
      const state = await this.provider.getExecutionState(quarantine.taskId);
      if (state.active?.id !== quarantine.executionId) {
        quarantine.durableSettled = true;
        this.#maybeClearQuarantine(quarantine);
        return;
      }
    } catch {
      return;
    }
    await this.#attemptReconciliationPersistence(quarantine, status);
  }

  #beginReconciliationCancellation(
    reservation: WorkerReservation,
    summary: string,
    status: string | undefined,
    persist: boolean,
  ): void {
    if (reservation.reconciliation || !reservation.executionId || !reservation.role) return;
    const quarantine: ReconciliationQuarantine = {
      taskId: reservation.taskId,
      executionId: reservation.executionId,
      role: reservation.role,
      configuration: reservation.configuration,
      reservation,
      summary,
      settled: deferred<void>(),
      durableSettled: !persist,
      localSettled: reservation.running === undefined,
    };
    reservation.reconciliation = quarantine;
    this.#quarantines.set(reservation.taskId, quarantine);

    if (persist && status !== undefined) void this.#attemptReconciliationPersistence(quarantine, status);
    if (reservation.running) this.#observeLocalReconciliation(quarantine, reservation.running);
    this.#maybeClearQuarantine(quarantine);
    void this.#releaseReconciliationCapacity(quarantine);
  }

  #observeLocalReconciliation(quarantine: ReconciliationQuarantine, running: RunningExecution): void {
    const resultSettled = running.result.then(() => undefined, () => undefined);
    const cancellationSettled = Promise.resolve().then(() => running.cancel("reconciliation")).then(
      () => undefined,
      () => resultSettled,
    );
    void Promise.race([resultSettled, cancellationSettled]).then(() => {
      quarantine.localSettled = true;
      this.#maybeClearQuarantine(quarantine);
    });
  }

  async #attemptReconciliationPersistence(quarantine: ReconciliationQuarantine, status: string): Promise<void> {
    if (quarantine.durableSettled) return;
    if (quarantine.providerAttempt) return quarantine.providerAttempt;
    let attempt!: Promise<void>;
    attempt = this.#persistCancellation(
      quarantine.taskId,
      quarantine.role,
      quarantine.executionId,
      "reconciliation",
      status,
      quarantine.summary,
    ).then(
      (report) => {
        quarantine.lastReport = report;
        quarantine.durableSettled = true;
      },
      (error: unknown) => {
        quarantine.lastReport = failureReport(quarantine.taskId, quarantine.role, error);
      },
    ).finally(() => {
      if (quarantine.providerAttempt === attempt) quarantine.providerAttempt = undefined;
      this.#maybeClearQuarantine(quarantine);
    });
    quarantine.providerAttempt = attempt;
    return attempt;
  }

  async #releaseReconciliationCapacity(quarantine: ReconciliationQuarantine): Promise<void> {
    await waitWithin(quarantine.settled.promise, quarantine.configuration.timeouts.cancellationMs);
    quarantine.reservation.completion.resolve(reconciliationReport(quarantine));
    this.#release(quarantine.reservation);
  }

  #maybeClearQuarantine(quarantine: ReconciliationQuarantine): void {
    if (!quarantine.durableSettled || !quarantine.localSettled) return;
    if (this.#quarantines.get(quarantine.taskId) === quarantine) this.#quarantines.delete(quarantine.taskId);
    quarantine.settled.resolve();
    this.#notifyIdle();
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
      return await this.#persistCancellation(
        taskId,
        roleName,
        executionId,
        "shutdown",
        configuration.failedStatus,
        summary,
      );
    } catch (error) {
      return failureReport(taskId, roleName, error);
    }
  }

  async #persistCancellation(
    taskId: string,
    roleName: string,
    executionId: string,
    kind: "reconciliation" | "shutdown",
    status: string,
    summary: string,
  ): Promise<ScheduleReport> {
    await this.provider.cancelExecution(taskId, executionId, {
      record: {
        id: executionId,
        role: roleName,
        outcome: "cancelled",
        summary,
        finishedAt: new Date().toISOString(),
        failure: { kind, retryable: false },
      },
      status,
      comment: summary,
    });
    return { taskId, outcome: "failed", role: roleName, error: summary };
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

function reconciliationReason(task: Task, config: RepositoryConfiguration): string | undefined {
  const prefix = "Ensemble execution cancelled during reconciliation:";
  if (!sameRepository(task, config)) return `${prefix} task moved outside the captured repository route`;
  if (task.blockers?.some((blocker) => !blocker.resolved)) return `${prefix} task has an unresolved blocker`;
  if (task.dispatchable === false) return `${prefix} provider marked task ineligible`;
  if (!config.runnableStatuses.includes(task.status)) return `${prefix} status '${task.status}' is not runnable`;
  return undefined;
}

function sameRepository(task: Task, config: RepositoryConfiguration): boolean {
  const current = task.repository;
  const captured = config.repository;
  return current.id === captured.id
    && current.url === captured.url
    && current.defaultBranch === captured.defaultBranch
    && current.branch === captured.branch;
}

function reconciliationReport(quarantine: ReconciliationQuarantine): ScheduleReport {
  return quarantine.lastReport ?? {
    taskId: quarantine.taskId,
    outcome: "failed",
    role: quarantine.role,
    error: quarantine.summary,
  };
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
