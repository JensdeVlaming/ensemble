import type {
  SchedulerConfigurationReloadReport,
  SchedulerOperationalPolicy,
  SchedulerShutdownOptions,
  SchedulerShutdownReport,
  SchedulerStartupReport,
  SchedulerTickReport,
} from "./scheduler.ts";
import type { OperationalEventReporter } from "../domain/observability.ts";
import { emitOperational } from "../observability/logging.ts";

export type OrchestratorServiceState = "idle" | "starting" | "running" | "draining" | "stopped";

export interface OrchestratorScheduler {
  reloadConfiguration(): Promise<SchedulerConfigurationReloadReport>;
  startup(): Promise<SchedulerStartupReport>;
  tick(): Promise<SchedulerTickReport>;
  shutdown(options: SchedulerShutdownOptions): Promise<SchedulerShutdownReport>;
}

export interface OrchestratorRegistration {
  readonly id: string;
  readonly scheduler: OrchestratorScheduler;
  readonly startupTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly drainTimeoutMs: number;
  readonly cancellationTimeoutMs: number;
}

export interface RepositoryTickReport {
  readonly repositoryId: string;
  readonly outcome: "completed" | "failed";
  readonly dispatchedTaskIds: readonly string[];
  readonly configurationDiagnostic?: string;
  readonly error?: string;
}

export interface OrchestratorTickReport {
  readonly repositories: readonly RepositoryTickReport[];
}

export interface ServiceSnapshot {
  readonly generatedAt: string;
  readonly service: "starting" | "running" | "draining" | "stopped";
  readonly readiness: boolean;
  readonly repositories: readonly {
    readonly id: string;
    readonly initialized: boolean;
    readonly lastError?: string;
    readonly lastTick?: RepositoryTickReport;
  }[];
  readonly metrics: Readonly<Record<string, number>>;
}

export interface RepositoryShutdownReport {
  readonly repositoryId: string;
  readonly outcome: "completed" | "failed";
  readonly scheduler?: SchedulerShutdownReport;
  readonly error?: string;
}

export interface OrchestratorShutdownReport {
  readonly repositories: readonly RepositoryShutdownReport[];
}

export type ServiceSignal = "SIGINT" | "SIGTERM";

export interface ServiceSignalSource {
  addListener(signal: ServiceSignal, listener: () => void): void;
  removeListener(signal: ServiceSignal, listener: () => void): void;
}

export interface ServiceTimerSource {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

interface RegistrationState {
  readonly registration: OrchestratorRegistration;
  operationalPolicy: SchedulerOperationalPolicy;
  initialized: boolean;
  startup?: Promise<void>;
  tick?: Promise<RepositoryTickReport>;
  timer?: unknown;
  lastError?: string;
  lastTick?: RepositoryTickReport;
}

const nodeSignals: ServiceSignalSource = {
  addListener: (signal, listener) => { process.on(signal, listener); },
  removeListener: (signal, listener) => { process.off(signal, listener); },
};

const nodeTimers: ServiceTimerSource = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export class OrchestratorService {
  readonly #registrations: readonly RegistrationState[];
  readonly #signals: ServiceSignalSource;
  readonly #timers: ServiceTimerSource;
  readonly #events?: OperationalEventReporter;
  readonly #stop = deferred<void>();
  readonly #interruptListener = (): void => { this.#onSignal("SIGINT"); };
  readonly #terminateListener = (): void => { this.#onSignal("SIGTERM"); };
  #state: OrchestratorServiceState = "idle";
  #start?: Promise<void>;
  #shutdown?: Promise<OrchestratorShutdownReport>;
  #signalsInstalled = false;
  readonly #metrics = new Map<string, number>();

  constructor(
    registrations: readonly OrchestratorRegistration[],
    signals: ServiceSignalSource = nodeSignals,
    timers: ServiceTimerSource = nodeTimers,
    events?: OperationalEventReporter,
  ) {
    const ids = new Set<string>();
    this.#registrations = Object.freeze([...registrations].map((registration) => {
      if (!registration.id.trim()) throw new Error("Orchestrator registration ID is required");
      if (ids.has(registration.id)) throw new Error(`Duplicate orchestrator registration: ${registration.id}`);
      ids.add(registration.id);
      validateBound(registration.startupTimeoutMs, `${registration.id}.startupTimeoutMs`);
      validateBound(registration.pollIntervalMs, `${registration.id}.pollIntervalMs`);
      validateBound(registration.drainTimeoutMs, `${registration.id}.drainTimeoutMs`);
      validateBound(registration.cancellationTimeoutMs, `${registration.id}.cancellationTimeoutMs`);
      return {
        registration: Object.freeze({ ...registration }),
        initialized: false,
        operationalPolicy: Object.freeze({
          startupTimeoutMs: registration.startupTimeoutMs,
          pollIntervalMs: registration.pollIntervalMs,
          drainTimeoutMs: registration.drainTimeoutMs,
          cancellationTimeoutMs: registration.cancellationTimeoutMs,
        }),
      };
    }).sort((left, right) => left.registration.id.localeCompare(right.registration.id)));
    this.#signals = signals;
    this.#timers = timers;
    this.#events = events;
  }

  get state(): OrchestratorServiceState {
    return this.#state;
  }

  snapshot(now: () => Date = () => new Date()): ServiceSnapshot {
    const service = this.#state === "idle" ? "starting" : this.#state;
    return Object.freeze({
      generatedAt: now().toISOString(),
      service,
      readiness: this.#state === "running" && this.#registrations.every((entry) => entry.initialized),
      repositories: Object.freeze(this.#registrations.map((entry) => Object.freeze({
        id: entry.registration.id,
        initialized: entry.initialized,
        ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
        ...(entry.lastTick === undefined ? {} : { lastTick: entry.lastTick }),
      }))),
      metrics: Object.freeze(Object.fromEntries(this.#metrics.entries())),
    });
  }

  start(): Promise<void> {
    if (this.#state === "stopped") {
      return Promise.reject(new Error(`Cannot start service while ${this.#state}`));
    }
    if (this.#start) return this.#start;
    if (this.#state === "draining") return Promise.reject(new Error("Cannot start service while draining"));
    this.#state = "starting";
    this.#emit({ level: "info", event: "service.starting" });
    try {
      this.#installSignals();
    } catch (error) {
      this.#state = "stopped";
      this.#stop.resolve();
      this.#start = Promise.reject(error);
      return this.#start;
    }
    this.#start = this.#run();
    return this.#start;
  }

  async tick(): Promise<OrchestratorTickReport> {
    if (this.#state === "draining" || this.#state === "stopped") {
      throw new Error(`Cannot tick service while ${this.#state}`);
    }
    const reports = await Promise.all(this.#registrations.map((registration) => this.#tickRegistration(registration)));
    return Object.freeze({ repositories: Object.freeze(reports) });
  }

  shutdown(): Promise<OrchestratorShutdownReport> {
    this.#shutdown ??= this.#performShutdown();
    return this.#shutdown;
  }

  async #run(): Promise<void> {
    const startup = this.#startRegistrations();
    void startup.catch(() => undefined);
    try {
      await this.#stop.promise;
    } finally {
      this.#removeSignals();
    }
  }

  async #startRegistrations(): Promise<void> {
    await Promise.all(this.#registrations.map((registration) => this.#ensureStartup(registration).catch(() => undefined)));
    if (this.#state !== "starting") return;
    this.#state = "running";
    this.#emit({ level: "info", event: "service.running" });
    await Promise.all(this.#registrations.map((registration) => this.#tickInitializedRegistration(registration)));
    if (this.#state === "running") {
      for (const registration of this.#registrations) this.#schedule(registration);
    }
  }

  #tickInitializedRegistration(state: RegistrationState): Promise<RepositoryTickReport> {
    if (state.initialized) return this.#tickRegistration(state);
    return Promise.resolve(Object.freeze({
      repositoryId: state.registration.id,
      outcome: "failed" as const,
      dispatchedTaskIds: Object.freeze([]),
      error: state.lastError ?? "Repository startup failed",
    }));
  }

  #tickRegistration(state: RegistrationState): Promise<RepositoryTickReport> {
    if (state.tick) return state.tick;
    const tick = (async (): Promise<RepositoryTickReport> => {
      try {
        this.#emit({ level: "debug", event: "tick.started", repositoryId: state.registration.id });
        await this.#ensureStartup(state);
        if (isClosedState(this.#state)) {
          throw new Error(`Cannot dispatch ${state.registration.id} while ${this.#state}`);
        }
        const configuration = await this.#reloadConfiguration(state);
        if (isClosedState(this.#state)) {
          throw new Error(`Cannot dispatch ${state.registration.id} while ${this.#state}`);
        }
        const report = await state.registration.scheduler.tick();
        state.lastError = undefined;
        state.lastTick = Object.freeze({ repositoryId: state.registration.id, outcome: "completed",
          dispatchedTaskIds: Object.freeze([...report.dispatchedTaskIds]) });
        this.#increment("tick_success_total");
        this.#emit({ level: "info", event: "tick.completed", repositoryId: state.registration.id,
          data: { dispatchedCount: report.dispatchedTaskIds.length } });
        return Object.freeze({
          repositoryId: state.registration.id,
          outcome: "completed" as const,
          dispatchedTaskIds: Object.freeze([...report.dispatchedTaskIds]),
          ...(configuration.diagnostic === undefined
            ? {}
            : { configurationDiagnostic: boundedMessage(configuration.diagnostic) }),
        });
      } catch (error) {
        state.lastError = errorMessage(error);
        state.lastTick = Object.freeze({ repositoryId: state.registration.id, outcome: "failed",
          dispatchedTaskIds: Object.freeze([]), error: state.lastError });
        this.#increment("tick_failure_total");
        this.#emit({ level: "error", event: "tick.failed", repositoryId: state.registration.id,
          data: { errorCategory: "unexpected" } });
        return Object.freeze({
          repositoryId: state.registration.id,
          outcome: "failed" as const,
          dispatchedTaskIds: Object.freeze([]),
          error: state.lastError,
        });
      }
    })();
    state.tick = tick;
    void tick.finally(() => {
      if (state.tick === tick) state.tick = undefined;
    }).catch(() => undefined);
    return tick;
  }

  #ensureStartup(state: RegistrationState): Promise<void> {
    if (state.initialized) return Promise.resolve();
    if (state.startup) return state.startup;
    let acceptingResult = true;
    const operation = (async () => {
      try {
        this.#emit({ level: "info", event: "repository.startup_started", repositoryId: state.registration.id });
        await this.#reloadConfiguration(state);
        await state.registration.scheduler.startup();
        if (!acceptingResult) throw new Error(`Startup timed out for ${state.registration.id}`);
        if (this.#state === "draining" || this.#state === "stopped") {
          throw new Error(`Startup completed after intake closed for ${state.registration.id}`);
        }
        state.initialized = true;
        state.lastError = undefined;
        this.#increment("repository_startup_success_total");
        this.#emit({ level: "info", event: "repository.startup_succeeded", repositoryId: state.registration.id });
      } catch (error) {
        state.lastError = errorMessage(error);
        this.#increment("repository_startup_failure_total");
        this.#emit({ level: "error", event: "repository.startup_failed", repositoryId: state.registration.id,
          data: { errorCategory: "configuration" } });
        throw error;
      }
    })();
    const startup = withDeadline(operation, state.operationalPolicy.startupTimeoutMs, () => {
      acceptingResult = false;
    }, `Startup timed out for ${state.registration.id}`);
    state.startup = startup;
    void startup.finally(() => {
      if (state.startup === startup) state.startup = undefined;
    }).catch(() => undefined);
    return startup;
  }

  #schedule(state: RegistrationState): void {
    if (this.#state !== "running" || state.timer !== undefined) return;
    state.timer = this.#timers.set(state.operationalPolicy.pollIntervalMs, () => {
      state.timer = undefined;
      void this.#tickRegistration(state).finally(() => {
        if (this.#state === "running") this.#schedule(state);
      }).catch(() => undefined);
    });
    this.#emit({ level: "debug", event: "service.timer_scheduled", repositoryId: state.registration.id,
      data: { pollIntervalMs: state.operationalPolicy.pollIntervalMs } });
  }

  async #performShutdown(): Promise<OrchestratorShutdownReport> {
    if (this.#state === "stopped") return Object.freeze({ repositories: Object.freeze([]) });
    this.#state = "draining";
    this.#emit({ level: "info", event: "service.shutdown_started" });
    this.#removeSignals();
    for (const state of this.#registrations) {
      if (state.timer !== undefined) {
        this.#timers.clear(state.timer);
        state.timer = undefined;
      }
    }
    const reports = await Promise.all(this.#registrations.map(async (state): Promise<RepositoryShutdownReport> => {
      try {
        const scheduler = await state.registration.scheduler.shutdown({
          drainTimeoutMs: state.operationalPolicy.drainTimeoutMs,
          cancellationTimeoutMs: state.operationalPolicy.cancellationTimeoutMs,
        });
        this.#emit({ level: "info", event: "repository.shutdown_completed", repositoryId: state.registration.id,
          data: { drained: scheduler.drained, cancelledCount: scheduler.cancelledTaskIds.length,
            remainingCount: scheduler.remainingTaskIds.length } });
        return Object.freeze({
          repositoryId: state.registration.id,
          outcome: "completed",
          scheduler: Object.freeze({
            drained: scheduler.drained,
            cancelledTaskIds: Object.freeze([...scheduler.cancelledTaskIds]),
            remainingTaskIds: Object.freeze([...scheduler.remainingTaskIds]),
          }),
        });
      } catch (error) {
        this.#emit({ level: "error", event: "repository.shutdown_failed", repositoryId: state.registration.id,
          data: { errorCategory: "unexpected" } });
        return Object.freeze({ repositoryId: state.registration.id, outcome: "failed", error: errorMessage(error) });
      }
    }));
    this.#state = "stopped";
    this.#stop.resolve();
    this.#emit({ level: "info", event: "service.shutdown_completed" });
    return Object.freeze({ repositories: Object.freeze(reports) });
  }

  #installSignals(): void {
    if (this.#signalsInstalled) return;
    let interruptInstalled = false;
    try {
      this.#signals.addListener("SIGINT", this.#interruptListener);
      interruptInstalled = true;
      this.#signals.addListener("SIGTERM", this.#terminateListener);
      this.#signalsInstalled = true;
    } catch (error) {
      if (interruptInstalled) this.#signals.removeListener("SIGINT", this.#interruptListener);
      throw error;
    }
  }

  #removeSignals(): void {
    if (!this.#signalsInstalled) return;
    this.#signalsInstalled = false;
    this.#signals.removeListener("SIGINT", this.#interruptListener);
    this.#signals.removeListener("SIGTERM", this.#terminateListener);
  }

  async #reloadConfiguration(state: RegistrationState): Promise<SchedulerConfigurationReloadReport> {
    this.#emit({ level: "debug", event: "configuration.reload_started", repositoryId: state.registration.id });
    let reload: SchedulerConfigurationReloadReport;
    try { reload = await state.registration.scheduler.reloadConfiguration(); }
    catch (error) {
      this.#emit({ level: "error", event: "configuration.reload_failed", repositoryId: state.registration.id,
        data: { errorCategory: "configuration" } });
      throw error;
    }
    validateBound(reload.operationalPolicy.pollIntervalMs, `${state.registration.id}.pollIntervalMs`);
    validateBound(reload.operationalPolicy.startupTimeoutMs, `${state.registration.id}.startupTimeoutMs`);
    validateBound(reload.operationalPolicy.drainTimeoutMs, `${state.registration.id}.drainTimeoutMs`);
    validateBound(reload.operationalPolicy.cancellationTimeoutMs, `${state.registration.id}.cancellationTimeoutMs`);
    state.operationalPolicy = Object.freeze({ ...reload.operationalPolicy });
    const event = reload.status === "installed" ? "configuration.reload_installed"
      : reload.status === "unchanged" ? "configuration.reload_unchanged" : "configuration.reload_retained";
    this.#emit({ level: reload.status === "retained" ? "warn" : "info", event,
      repositoryId: state.registration.id, data: { revision: reload.revision, configurationStatus: reload.status } });
    return reload;
  }

  #onSignal(signal: ServiceSignal): void {
    this.#emit({ level: "info", event: "service.signal_received", data: { signal } });
    void this.shutdown().catch(() => undefined);
  }

  #emit(event: Parameters<typeof emitOperational>[1]): void { emitOperational(this.#events, event); }

  #increment(name: string): void { this.#metrics.set(name, (this.#metrics.get(name) ?? 0) + 1); }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function validateBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function errorMessage(error: unknown): string {
  return boundedMessage(error instanceof Error ? error.message : String(error));
}

function boundedMessage(message: string): string {
  return message.length <= 1_024 ? message : `${message.slice(0, 1_023)}…`;
}

function isClosedState(state: OrchestratorServiceState): boolean {
  return state === "draining" || state === "stopped";
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  expire: () => void,
  message: string,
): Promise<T> {
  if (timeoutMs === 0) {
    expire();
    void operation.catch(() => undefined);
    return Promise.reject(new Error(message));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expire();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
