import { randomUUID } from "node:crypto";
import { ExecutionCancelledError } from "../execution/engine.ts";
import type { ConfiguredExecution, RunningExecution, TaskExecutionService } from "../execution/engine.ts";
import { ConfigurationReloadError } from "../execution/repository.ts";
import type { ConfigurationReloadStatus } from "../execution/repository.ts";
import { ProviderClaimConflict } from "../providers/provider.ts";
import type {
  ActiveExecution,
  ExecutionCompletion,
  ExecutionLeaseBasis,
  ExecutionLeaseClaim,
  ExecutionLeaseGuard,
  ExecutionRecord,
  ProviderAdapter,
  ProviderExecutionState,
  TaskRefreshResult,
} from "../providers/provider.ts";
import type { FailureKind, RepositoryConfiguration, RuntimeResult, Task } from "../domain/model.ts";

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

export interface SchedulerOperationalPolicy {
  readonly pollIntervalMs: number;
  readonly drainTimeoutMs: number;
  readonly cancellationTimeoutMs: number;
}

export interface SchedulerConfigurationReloadReport {
  readonly status: ConfigurationReloadStatus;
  readonly revision: string;
  readonly operationalPolicy: SchedulerOperationalPolicy;
  readonly diagnostic?: string;
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

export interface SchedulerOptions {
  readonly now?: () => Date;
  readonly lease?: Partial<SchedulerLeasePolicy>;
  readonly timers?: SchedulerTimerSource;
}

export interface SchedulerLeasePolicy {
  readonly ownerId: string;
  readonly durationMs: number;
  readonly renewIntervalMs: number;
}

export interface SchedulerTimerSource {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export const processExecutionOwner = Object.freeze({ id: randomUUID() });

interface WorkerReservation {
  readonly taskId: string;
  readonly configuration: RepositoryConfiguration;
  readonly completion: Deferred<ScheduleReport | undefined>;
  status: string;
  executionId?: string;
  role?: string;
  running?: RunningExecution;
  reconciliation?: ReconciliationQuarantine;
  lease?: LeaseController;
  leaseTransferred?: boolean;
}

interface LeaseController {
  readonly reservation: WorkerReservation;
  active: ActiveExecution & Required<Pick<ActiveExecution, "ownerId" | "leaseExpiresAt">>;
  timer?: unknown;
  renewal?: Promise<void>;
  operationTail: Promise<void>;
  lost?: Error;
  stopped: boolean;
}

interface ReconciliationQuarantine {
  readonly taskId: string;
  readonly executionId: string;
  readonly role: string;
  readonly configuration: RepositoryConfiguration;
  readonly reservation: WorkerReservation;
  readonly summary: string;
  readonly lease: LeaseController;
  readonly settled: Deferred<void>;
  durableSettled: boolean;
  localSettled: boolean;
  providerAttempt?: Promise<void>;
  lastReport?: ScheduleReport;
}

interface SynchronizationQuarantine {
  readonly taskId: string;
  readonly executionId: string;
  readonly record: ExecutionRecord;
  readonly synchronize: (guard: ExecutionLeaseGuard) => Promise<void>;
  readonly lease: LeaseController;
  attempt?: Promise<void>;
  lastError?: string;
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
  readonly #synchronizations = new Map<string, SynchronizationQuarantine>();
  readonly #idleWaiters = new Set<() => void>();
  #tickInProgress?: Promise<readonly DispatchEntry[]>;
  #pollDispatchTail: Promise<void> = Promise.resolve();
  #accepting = true;
  #shutdown?: Promise<SchedulerShutdownReport>;
  readonly provider: ProviderAdapter;
  readonly executions: TaskExecutionService;
  readonly #now: () => Date;
  readonly #leasePolicy: SchedulerLeasePolicy;
  readonly #timers: SchedulerTimerSource;

  constructor(provider: ProviderAdapter, executions: TaskExecutionService, options: SchedulerOptions = {}) {
    this.provider = provider;
    this.executions = executions;
    this.#now = options.now ?? (() => new Date());
    this.#leasePolicy = validateLeasePolicy(options.lease);
    this.#timers = options.timers ?? nodeSchedulerTimers;
  }

  async reloadConfiguration(): Promise<SchedulerConfigurationReloadReport> {
    try {
      const reload = await this.executions.reloadConfiguration();
      const configuration = reload.configuration;
      return Object.freeze({
        status: reload.status,
        revision: reload.revision,
        operationalPolicy: Object.freeze({
          pollIntervalMs: configuration.service.pollIntervalMs,
          drainTimeoutMs: configuration.shutdown.drainTimeoutMs,
          cancellationTimeoutMs: configuration.timeouts.cancellationMs,
        }),
        ...(reload.diagnostic === undefined ? {} : { diagnostic: reload.diagnostic }),
      });
    } catch (error) {
      if (error instanceof ConfigurationReloadError) throw error;
      throw new ConfigurationReloadError("Configuration reload failed");
    }
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
      if (reconciledTaskIds.has(discovered.id) || this.#workers.has(discovered.id)
        || this.#quarantines.has(discovered.id) || this.#synchronizations.has(discovered.id)) continue;
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
    if (this.#workers.has(task.id) || this.#quarantines.has(task.id) || this.#synchronizations.has(task.id)) return undefined;
    try {
      return await this.executions.withConfiguration(task, async (execution) => {
        if (!this.#accepting || this.#workers.has(task.id) || this.#quarantines.has(task.id) || this.#synchronizations.has(task.id)
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
    let state: ProviderExecutionState | undefined;
    let failureKind: FailureKind = "provider";
    try {
      state = await this.provider.getExecutionState(task.id);
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      const selectedRole = selectRole(state, execution.configuration);
      roleName = selectedRole;
      if (state.active) {
        executionId = state.active.id;
        roleName = state.active.role;
        reservation.executionId = state.active.id;
        reservation.role = state.active.role;
        if (isForeignLiveLease(state.active, this.#leasePolicy.ownerId, this.#nowEpoch())) {
          this.#release(reservation);
          completion.resolve(undefined);
          return entry(false);
        }
      }
      if (task.dispatchable === false && !state.active) {
        this.#release(reservation);
        completion.resolve(undefined);
        return entry(false);
      }
      if (!state.active && !isEligible(task, state, selectedRole, execution.configuration, this.#nowEpoch())) {
        this.#release(reservation);
        completion.resolve(undefined);
        return entry(false);
      }

      const active = await this.provider.beginExecution(
        task.id,
        selectedRole,
        execution.configuration.runningStatus,
        this.#leaseClaim(state.active),
      );
      executionId = active.id;
      roleName = active.role;
      reservation.executionId = active.id;
      reservation.role = active.role;
      reservation.lease = this.#startLease(reservation, active);
      if (!state.active) reservation.status = execution.configuration.runningStatus;
      const reason = state.active ? reconciliationReason(task, execution.configuration) : undefined;
      if (reason) {
        this.#beginReconciliationCancellation(reservation, reason, task.status, true);
        return entry(false);
      }
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      failureKind = "configuration";
      const role = execution.configuration.workflow.roles.find((candidate) => candidate.name === roleName);
      if (!role) throw new Error(`Unknown role '${roleName}' for task ${task.id}`);
      failureKind = "provider";
      const [comments, artifacts] = await Promise.all([
        this.provider.getComments(task.id),
        this.provider.getArtifacts(task.id),
      ]);
      this.#assertLeaseOwned(reservation);
      if (!this.#accepting) return await this.#stopReservation(task, reservation, roleName, executionId, completion, entry);
      failureKind = "startup";
      const running = await execution.withEnvironment((environment) => environment.start({
        task,
        role,
        comments,
        artifacts,
        executionId: active.id,
      }));
      reservation.running = running;
      if (reservation.lease.lost) void running.cancel("lease_lost").catch(() => undefined);
      if (!this.#accepting) {
        void running.cancel("shutdown").catch(() => undefined);
      }
      void this.#completeWorker(task, reservation, roleName, active.id, state.history, running).then(
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
      const report = await this.#recordFailure(
        task,
        reservation,
        roleName,
        executionId,
        state?.history ?? [],
        failureKind,
        error,
      );
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
    history: readonly ExecutionRecord[],
    running: RunningExecution,
  ): Promise<ScheduleReport> {
    try {
      const report = await running.result;
      if (reservation.reconciliation) return reconciliationReport(reservation.reconciliation);
      this.#assertLeaseOwned(reservation);
      return await this.#synchronizeResult(task, reservation, roleName, executionId, report.result);
    } catch (error) {
      if (reservation.reconciliation) return reconciliationReport(reservation.reconciliation);
      if (reservation.lease?.lost || (error instanceof ExecutionCancelledError && error.reason === "lease_lost")) {
        return failureReport(task.id, roleName, reservation.lease?.lost ?? error);
      }
      if (error instanceof ExecutionCancelledError && error.reason === "shutdown") {
        return this.#recordCancellation(task.id, reservation, roleName, executionId);
      }
      const kind: FailureKind = error instanceof ExecutionCancelledError && (error.reason === "timeout" || error.reason === "stalled")
        ? error.reason
        : "runtime";
      return this.#recordFailure(task, reservation, roleName, executionId, history, kind, error);
    } finally {
      if (!reservation.reconciliation) this.#release(reservation);
    }
  }

  async #recordFailure(
    task: Task,
    reservation: WorkerReservation,
    roleName: string,
    executionId: string | undefined,
    history: readonly ExecutionRecord[],
    kind: FailureKind,
    error: unknown,
  ): Promise<ScheduleReport> {
    const configuration = reservation.configuration;
    let reportError = error;
    if (executionId && reservation.lease && !reservation.lease.lost) {
      const message = errorMessage(error);
      const record = failureRecord(
        executionId,
        roleName,
        message,
        kind,
        history,
        configuration,
        this.#nowDate(),
      );
      const comment = `Ensemble execution failed: ${message}`;
      const synchronize = (guard: ExecutionLeaseGuard): Promise<void> => this.provider.failExecution(
        task.id,
        executionId,
        guard,
        record,
        configuration.failedStatus,
        comment,
      );
      try {
        await this.#withLeaseGuard(reservation.lease, synchronize);
      } catch (synchronizationError) {
        if (synchronizationError instanceof ProviderClaimConflict) this.#loseLease(reservation.lease, synchronizationError);
        else this.#registerSynchronization(task.id, executionId, record, synchronize, reservation.lease, synchronizationError);
        reportError = synchronizationError;
      }
    }
    return failureReport(task.id, roleName, reportError);
  }

  #registerSynchronization(
    taskId: string,
    executionId: string,
    record: ExecutionRecord,
    synchronize: (guard: ExecutionLeaseGuard) => Promise<void>,
    lease: LeaseController,
    error: unknown,
  ): void {
    if (this.#synchronizations.has(taskId)) return;
    this.#synchronizations.set(taskId, {
      taskId,
      executionId,
      record,
      synchronize,
      lease,
      lastError: errorMessage(error),
    });
    lease.reservation.leaseTransferred = true;
  }

  #nowDate(): Date {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Scheduler clock returned an invalid date");
    return new Date(value.getTime());
  }

  #nowEpoch(): number {
    return this.#nowDate().getTime();
  }

  #release(reservation: WorkerReservation): void {
    if (reservation.lease && !reservation.leaseTransferred) this.#stopLease(reservation.lease);
    if (this.#workers.get(reservation.taskId) === reservation) this.#workers.delete(reservation.taskId);
    this.#notifyIdle();
  }

  async shutdown(options: SchedulerShutdownOptions): Promise<SchedulerShutdownReport> {
    this.#accepting = false;
    this.#shutdown ??= this.#performShutdown(options);
    return this.#shutdown;
  }

  async #performShutdown(options: SchedulerShutdownOptions): Promise<SchedulerShutdownReport> {
    if (this.#workers.size === 0 && this.#quarantines.size === 0 && this.#synchronizations.size === 0
      && this.#tickInProgress === undefined) {
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
          reservation,
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
    for (const synchronization of [...this.#synchronizations.values()]) this.#dropSynchronization(synchronization);
    return Object.freeze({
      drained: this.#workers.size === 0 && this.#quarantines.size === 0 && this.#synchronizations.size === 0
        && this.#tickInProgress === undefined,
      cancelledTaskIds: Object.freeze(cancelledTaskIds),
      remainingTaskIds: Object.freeze([...new Set([
        ...this.#workers.keys(),
        ...this.#quarantines.keys(),
        ...this.#synchronizations.keys(),
      ])].sort()),
    });
  }

  #waitForIdle(): Promise<void> {
    if (this.#workers.size === 0 && this.#quarantines.size === 0 && this.#synchronizations.size === 0
      && this.#tickInProgress === undefined) return Promise.resolve();
    return new Promise((resolve) => { this.#idleWaiters.add(resolve); });
  }

  #notifyIdle(): void {
    if (this.#workers.size !== 0 || this.#quarantines.size !== 0 || this.#synchronizations.size !== 0
      || this.#tickInProgress !== undefined) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async #reconcileActiveWork(): Promise<ReadonlySet<string>> {
    const taskIds = [...new Set([
      ...this.#workers.keys(),
      ...this.#quarantines.keys(),
      ...this.#synchronizations.keys(),
    ])].sort();
    const excluded = new Set([...this.#quarantines.keys(), ...this.#synchronizations.keys()]);
    if (taskIds.length === 0) return excluded;
    const refreshed = await this.provider.refreshTasks(taskIds);
    for (const taskId of taskIds) {
      const result = refreshed.get(taskId);
      if (!result || result.kind === "unreadable") continue;
      const synchronization = this.#synchronizations.get(taskId);
      if (synchronization) {
        this.#reconcileSynchronization(synchronization, result);
        continue;
      }
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

  #reconcileSynchronization(
    synchronization: SynchronizationQuarantine,
    result: Exclude<TaskRefreshResult, { readonly kind: "unreadable" }>,
  ): void {
    if (result.kind === "missing") {
      if (this.#synchronizations.get(synchronization.taskId) === synchronization) {
        this.#synchronizations.delete(synchronization.taskId);
      }
      this.#stopLease(synchronization.lease);
      this.#notifyIdle();
      return;
    }
    void this.#confirmOrRetrySynchronization(synchronization).catch(() => undefined);
  }

  async #confirmOrRetrySynchronization(synchronization: SynchronizationQuarantine): Promise<void> {
    if (synchronization.attempt) return synchronization.attempt;
    if (synchronization.lease.lost) {
      this.#dropSynchronization(synchronization);
      return;
    }
    let state: ProviderExecutionState;
    try {
      state = await this.provider.getExecutionState(synchronization.taskId);
    } catch (error) {
      synchronization.lastError = errorMessage(error);
      return;
    }
    const existing = state.history.find((record) => record.id === synchronization.executionId);
    if (existing && !sameExecutionRecord(existing, synchronization.record)) {
      synchronization.lastError = `Conflicting durable execution record: ${synchronization.executionId}`;
      return;
    }
    if (!existing && state.active?.id !== synchronization.executionId) {
      synchronization.lastError = `Execution is neither active nor durably synchronized: ${synchronization.executionId}`;
      return;
    }

    let attempt!: Promise<void>;
    attempt = this.#withLeaseGuard(synchronization.lease, synchronization.synchronize).then(
      () => {
        this.#dropSynchronization(synchronization);
      },
      (error: unknown) => {
        synchronization.lastError = errorMessage(error);
        if (error instanceof ProviderClaimConflict) {
          this.#loseLease(synchronization.lease, error);
          this.#dropSynchronization(synchronization);
        }
      },
    ).finally(() => {
      if (synchronization.attempt === attempt) synchronization.attempt = undefined;
      this.#notifyIdle();
    });
    synchronization.attempt = attempt;
    return attempt;
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
      lease: reservation.lease!,
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
      quarantine.lease,
    ).then(
      (report) => {
        quarantine.lastReport = report;
        quarantine.durableSettled = true;
      },
      (error: unknown) => {
        quarantine.lastReport = failureReport(quarantine.taskId, quarantine.role, error);
        if (error instanceof ProviderClaimConflict || quarantine.lease.lost) quarantine.durableSettled = true;
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
      ? await this.#recordCancellation(task.id, reservation, roleName, executionId)
      : undefined;
    this.#release(reservation);
    completion.resolve(report);
    return entry(false);
  }

  async #recordCancellation(
    taskId: string,
    reservation: WorkerReservation,
    roleName: string,
    executionId: string,
  ): Promise<ScheduleReport> {
    const configuration = reservation.configuration;
    const summary = "Ensemble execution cancelled during shutdown";
    try {
      return await this.#persistCancellation(
        taskId,
        roleName,
        executionId,
        "shutdown",
        configuration.failedStatus,
        summary,
        reservation.lease!,
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
    lease: LeaseController,
  ): Promise<ScheduleReport> {
    const cancellation = {
      record: {
        id: executionId, role: roleName, outcome: "cancelled", summary,
        finishedAt: this.#nowDate().toISOString(), failure: { kind, retryable: false } as const,
      }, status, comment: summary,
    };
    await this.#withLeaseGuard(lease, (guard) => this.provider.cancelExecution(taskId, executionId, guard, cancellation));
    return { taskId, outcome: "failed", role: roleName, error: summary };
  }

  async #synchronizeResult(
    task: Task,
    reservation: WorkerReservation,
    role: string,
    executionId: string,
    result: RuntimeResult,
  ): Promise<ScheduleReport> {
    const config = reservation.configuration;
    const terminal = config.terminalOutcomes.includes(result.outcome);
    if (!terminal && !result.nextRole) throw new Error(`Non-terminal outcome '${result.outcome}' requires nextRole`);
    if (result.nextRole && !config.workflow.roles.some((candidate) => candidate.name === result.nextRole)) {
      throw new Error(`Runtime requested unknown next role: ${result.nextRole}`);
    }
    const record: ExecutionRecord = Object.freeze({
      id: executionId,
      role,
      outcome: result.outcome,
      summary: result.summary,
      nextRole: terminal ? undefined : result.nextRole,
      finishedAt: this.#nowDate().toISOString(),
    });
    const completion: ExecutionCompletion = Object.freeze({
      record,
      comments: Object.freeze([...result.comments, result.summary]),
      artifacts: Object.freeze(result.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
      status: terminal ? config.completedStatus : config.runningStatus,
    });
    const lease = reservation.lease!;
    const synchronize = (guard: ExecutionLeaseGuard): Promise<void> => this.provider.completeExecution(task.id, executionId, guard, completion);
    try {
      await this.#withLeaseGuard(lease, synchronize);
    } catch (error) {
      if (error instanceof ProviderClaimConflict) this.#loseLease(lease, error);
      else this.#registerSynchronization(task.id, executionId, record, synchronize, lease, error);
      return failureReport(task.id, role, error);
    }
    return {
      taskId: task.id,
      outcome: terminal ? "completed" : "advanced",
      role,
      nextRole: result.nextRole,
    };
  }

  #leaseClaim(active: ActiveExecution | undefined): ExecutionLeaseClaim {
    const observed = this.#nowDate();
    const maximumEpoch = 8_640_000_000_000_000;
    const expiresEpoch = Math.min(maximumEpoch, observed.getTime() + this.#leasePolicy.durationMs);
    if (expiresEpoch <= observed.getTime()) throw new Error("Scheduler clock cannot create a future execution lease");
    return Object.freeze({
      ownerId: this.#leasePolicy.ownerId,
      observedAt: observed.toISOString(),
      expiresAt: new Date(expiresEpoch).toISOString(),
      expected: leaseBasis(active),
    });
  }

  #startLease(reservation: WorkerReservation, active: ActiveExecution): LeaseController {
    if (!active.ownerId || !active.leaseExpiresAt) throw new Error(`Provider returned an unleased execution: ${active.id}`);
    const lease: LeaseController = {
      reservation,
      active: { ...active, ownerId: active.ownerId, leaseExpiresAt: active.leaseExpiresAt },
      operationTail: Promise.resolve(),
      stopped: false,
    };
    this.#scheduleRenewal(lease);
    return lease;
  }

  #scheduleRenewal(lease: LeaseController): void {
    if (lease.stopped || lease.lost) return;
    const remaining = Date.parse(lease.active.leaseExpiresAt) - this.#nowEpoch();
    lease.timer = this.#timers.set(Math.max(1, Math.min(this.#leasePolicy.renewIntervalMs, remaining)), () => {
      lease.timer = undefined;
      if (lease.stopped || lease.lost || lease.renewal) return;
      const renewal = this.#serializeLease(lease, () => this.#renewLease(lease)).finally(() => {
        if (lease.renewal === renewal) lease.renewal = undefined;
        this.#scheduleRenewal(lease);
      });
      lease.renewal = renewal;
    });
  }

  async #renewLease(lease: LeaseController): Promise<void> {
    try {
      const renewed = await this.provider.renewExecutionLease(
        lease.reservation.taskId,
        lease.active.id,
        this.#leaseClaim(lease.active),
      );
      if (!renewed.ownerId || !renewed.leaseExpiresAt) throw new Error("Provider returned an invalid renewed lease");
      lease.active = { ...renewed, ownerId: renewed.ownerId, leaseExpiresAt: renewed.leaseExpiresAt };
    } catch (error) {
      if (error instanceof ProviderClaimConflict || this.#nowEpoch() >= Date.parse(lease.active.leaseExpiresAt)) {
        this.#loseLease(lease, error);
      }
    }
  }

  #leaseGuard(lease: LeaseController): ExecutionLeaseGuard {
    if (lease.lost) throw lease.lost;
    const observedAt = this.#nowDate().toISOString();
    if (Date.parse(observedAt) >= Date.parse(lease.active.leaseExpiresAt)) {
      const error = new Error(`Execution lease expired: ${lease.active.id}`);
      this.#loseLease(lease, error);
      throw error;
    }
    return Object.freeze({ ownerId: lease.active.ownerId, leaseExpiresAt: lease.active.leaseExpiresAt, observedAt });
  }

  async #withLeaseGuard<T>(lease: LeaseController, operation: (guard: ExecutionLeaseGuard) => Promise<T>): Promise<T> {
    return this.#serializeLease(lease, () => operation(this.#leaseGuard(lease)));
  }

  #serializeLease<T>(lease: LeaseController, operation: () => Promise<T>): Promise<T> {
    const result = lease.operationTail.then(operation, operation);
    lease.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertLeaseOwned(reservation: WorkerReservation): void {
    if (!reservation.lease) throw new Error(`Execution has no ownership lease: ${reservation.taskId}`);
    this.#leaseGuard(reservation.lease);
  }

  #loseLease(lease: LeaseController, cause: unknown): void {
    if (lease.lost) return;
    lease.lost = cause instanceof Error ? cause : new Error(errorMessage(cause));
    this.#stopLease(lease);
    const running = lease.reservation.running;
    if (running) {
      void running.cancel("lease_lost").catch(() => undefined);
      void running.result.catch(() => undefined);
    }
    const synchronization = this.#synchronizations.get(lease.reservation.taskId);
    if (synchronization?.lease === lease) this.#dropSynchronization(synchronization);
    const reconciliation = lease.reservation.reconciliation;
    if (reconciliation) {
      reconciliation.durableSettled = true;
      this.#maybeClearQuarantine(reconciliation);
    }
  }

  #stopLease(lease: LeaseController): void {
    lease.stopped = true;
    if (lease.timer !== undefined) this.#timers.clear(lease.timer);
    lease.timer = undefined;
  }

  #dropSynchronization(synchronization: SynchronizationQuarantine): void {
    if (this.#synchronizations.get(synchronization.taskId) === synchronization) this.#synchronizations.delete(synchronization.taskId);
    this.#stopLease(synchronization.lease);
    this.#notifyIdle();
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

const nodeSchedulerTimers: SchedulerTimerSource = Object.freeze({
  set: (delayMs: number, callback: () => void) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function validateLeasePolicy(value: Partial<SchedulerLeasePolicy> | undefined): SchedulerLeasePolicy {
  const policy = {
    ownerId: value?.ownerId ?? processExecutionOwner.id,
    durationMs: value?.durationMs ?? 60_000,
    renewIntervalMs: value?.renewIntervalMs ?? 20_000,
  };
  if (!policy.ownerId.trim()) throw new Error("Scheduler lease owner must not be empty");
  if (!Number.isSafeInteger(policy.durationMs) || policy.durationMs <= 0) throw new Error("Scheduler lease duration must be a positive integer");
  if (!Number.isSafeInteger(policy.renewIntervalMs) || policy.renewIntervalMs <= 0
    || policy.renewIntervalMs >= policy.durationMs) {
    throw new Error("Scheduler lease renewal interval must be a positive integer smaller than its duration");
  }
  return Object.freeze(policy);
}

function leaseBasis(active: ActiveExecution | undefined): ExecutionLeaseBasis {
  if (!active) return Object.freeze({ kind: "none" });
  if (!active.ownerId || !active.leaseExpiresAt) {
    return Object.freeze({ kind: "legacy", executionId: active.id, role: active.role, startedAt: active.startedAt });
  }
  return Object.freeze({
    kind: "leased",
    executionId: active.id,
    role: active.role,
    startedAt: active.startedAt,
    ownerId: active.ownerId,
    leaseExpiresAt: active.leaseExpiresAt,
  });
}

function isForeignLiveLease(active: ActiveExecution, ownerId: string, nowEpoch: number): boolean {
  return active.ownerId !== undefined && active.leaseExpiresAt !== undefined
    && active.ownerId !== ownerId && Date.parse(active.leaseExpiresAt) > nowEpoch;
}

function selectRole(state: ProviderExecutionState, config: RepositoryConfiguration): string {
  if (state.active) return state.active.role;
  if (state.nextRole) return state.nextRole;
  const latestFailure = [...state.history].reverse().find((record) => record.outcome === "failed");
  return latestFailure?.role ?? config.initialRole;
}

function isEligible(
  task: Task,
  state: ProviderExecutionState,
  role: string,
  config: RepositoryConfiguration,
  nowEpoch: number,
): boolean {
  if (task.dispatchable === false || task.blockers?.some((blocker) => !blocker.resolved)) return false;
  const latest = state.history.at(-1);
  const retrying = latest?.outcome === "failed";
  if (!retrying) return config.runnableStatuses.includes(task.status);
  if (!latest.failure?.retryable || !config.retry.retryableFailureKinds.includes(latest.failure.kind)) return false;
  const due = latest.failure.nextAttemptAt === undefined ? Number.NaN : Date.parse(latest.failure.nextAttemptAt);
  if (!Number.isFinite(due) || due > nowEpoch) return false;
  const failures = state.history.filter((record: ExecutionRecord) => record.role === role && record.outcome === "failed").length;
  return failures < config.retry.maxFailedAttemptsPerRole;
}

function failureRecord(
  executionId: string,
  role: string,
  summary: string,
  kind: FailureKind,
  history: readonly ExecutionRecord[],
  config: RepositoryConfiguration,
  finished: Date,
): ExecutionRecord {
  const retryNumber = history.filter((record) => record.role === role && record.outcome === "failed").length + 1;
  const retryable = config.retry.retryableFailureKinds.includes(kind)
    && retryNumber < config.retry.maxFailedAttemptsPerRole;
  const finishedAt = finished.toISOString();
  const failure = retryable
    ? Object.freeze({
      kind,
      retryable: true as const,
      nextAttemptAt: retryDueAt(finished, retryNumber, executionId, config),
    })
    : Object.freeze({ kind, retryable: false as const });
  return Object.freeze({
    id: executionId,
    role,
    outcome: "failed",
    summary,
    finishedAt,
    failure,
  });
}

function retryDueAt(finished: Date, retryNumber: number, executionId: string, config: RepositoryConfiguration): string {
  const delay = exponentialDelay(
    config.retry.initialDelayMs,
    config.retry.maxDelayMs,
    config.retry.multiplier,
    retryNumber - 1,
  );
  const hash = fnv1a(executionId);
  const signed = (2 * (hash / 4_294_967_295)) - 1;
  const offset = Math.round(delay * config.retry.jitterRatio * signed);
  const adjusted = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, delay + offset));
  const finishedEpoch = finished.getTime();
  const maximumEpoch = 8_640_000_000_000_000;
  const dueEpoch = adjusted >= maximumEpoch - finishedEpoch ? maximumEpoch : finishedEpoch + adjusted;
  return new Date(dueEpoch).toISOString();
}

function exponentialDelay(initial: number, maximum: number, multiplier: number, exponent: number): number {
  if (initial === 0 || maximum === 0) return 0;
  let result = Math.min(initial, maximum);
  let factor = multiplier;
  let remaining = exponent;
  while (remaining > 0 && result < maximum) {
    if (remaining % 2 === 1) result = saturatedMultiply(result, factor, maximum);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = saturatedMultiply(factor, factor, maximum);
  }
  return Math.round(Math.min(maximum, result));
}

function saturatedMultiply(left: number, right: number, maximum: number): number {
  if (left === 0 || right === 0) return 0;
  if (!Number.isFinite(left) || !Number.isFinite(right) || left >= maximum / right) return maximum;
  return left * right;
}

function fnv1a(value: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

function sameExecutionRecord(left: ExecutionRecord, right: ExecutionRecord): boolean {
  return left.id === right.id
    && left.role === right.role
    && left.outcome === right.outcome
    && left.summary === right.summary
    && left.nextRole === right.nextRole
    && left.finishedAt === right.finishedAt
    && sameFailure(left.failure, right.failure)
    && sameBlockingRequest(left.blockingRequest, right.blockingRequest);
}

function sameFailure(left: ExecutionRecord["failure"], right: ExecutionRecord["failure"]): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.retryable === right.retryable && left.nextAttemptAt === right.nextAttemptAt;
}

function sameBlockingRequest(left: ExecutionRecord["blockingRequest"], right: ExecutionRecord["blockingRequest"]): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind
    && left.summary === right.summary
    && left.requestId === right.requestId
    && left.createdAt === right.createdAt;
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
