import type {
  SchedulerConfigurationReloadReport,
  SchedulerOperationalPolicy,
  SchedulerShutdownOptions,
  SchedulerShutdownReport,
  SchedulerStartupReport,
  SchedulerTickReport,
} from "./scheduler.ts";

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
  readonly #stop = deferred<void>();
  readonly #signalListener = (): void => { void this.shutdown().catch(() => undefined); };
  #state: OrchestratorServiceState = "idle";
  #start?: Promise<void>;
  #shutdown?: Promise<OrchestratorShutdownReport>;
  #signalsInstalled = false;

  constructor(
    registrations: readonly OrchestratorRegistration[],
    signals: ServiceSignalSource = nodeSignals,
    timers: ServiceTimerSource = nodeTimers,
  ) {
    const ids = new Set<string>();
    this.#registrations = Object.freeze([...registrations].map((registration) => {
      if (!registration.id.trim()) throw new Error("Orchestrator registration ID is required");
      if (ids.has(registration.id)) throw new Error(`Duplicate orchestrator registration: ${registration.id}`);
      ids.add(registration.id);
      validateBound(registration.pollIntervalMs, `${registration.id}.pollIntervalMs`);
      validateBound(registration.drainTimeoutMs, `${registration.id}.drainTimeoutMs`);
      validateBound(registration.cancellationTimeoutMs, `${registration.id}.cancellationTimeoutMs`);
      return {
        registration: Object.freeze({ ...registration }),
        initialized: false,
        operationalPolicy: Object.freeze({
          pollIntervalMs: registration.pollIntervalMs,
          drainTimeoutMs: registration.drainTimeoutMs,
          cancellationTimeoutMs: registration.cancellationTimeoutMs,
        }),
      };
    }).sort((left, right) => left.registration.id.localeCompare(right.registration.id)));
    this.#signals = signals;
    this.#timers = timers;
  }

  get state(): OrchestratorServiceState {
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#state === "stopped") {
      return Promise.reject(new Error(`Cannot start service while ${this.#state}`));
    }
    if (this.#start) return this.#start;
    if (this.#state === "draining") return Promise.reject(new Error("Cannot start service while draining"));
    this.#state = "starting";
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
    const startup = (async () => {
      try {
        await this.#reloadConfiguration(state);
        await state.registration.scheduler.startup();
        if (this.#state === "draining" || this.#state === "stopped") {
          throw new Error(`Startup completed after intake closed for ${state.registration.id}`);
        }
        state.initialized = true;
        state.lastError = undefined;
      } catch (error) {
        state.lastError = errorMessage(error);
        throw error;
      }
    })();
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
  }

  async #performShutdown(): Promise<OrchestratorShutdownReport> {
    if (this.#state === "stopped") return Object.freeze({ repositories: Object.freeze([]) });
    this.#state = "draining";
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
        return Object.freeze({ repositoryId: state.registration.id, outcome: "failed", error: errorMessage(error) });
      }
    }));
    this.#state = "stopped";
    this.#stop.resolve();
    return Object.freeze({ repositories: Object.freeze(reports) });
  }

  #installSignals(): void {
    if (this.#signalsInstalled) return;
    let interruptInstalled = false;
    try {
      this.#signals.addListener("SIGINT", this.#signalListener);
      interruptInstalled = true;
      this.#signals.addListener("SIGTERM", this.#signalListener);
      this.#signalsInstalled = true;
    } catch (error) {
      if (interruptInstalled) this.#signals.removeListener("SIGINT", this.#signalListener);
      throw error;
    }
  }

  #removeSignals(): void {
    if (!this.#signalsInstalled) return;
    this.#signalsInstalled = false;
    this.#signals.removeListener("SIGINT", this.#signalListener);
    this.#signals.removeListener("SIGTERM", this.#signalListener);
  }

  async #reloadConfiguration(state: RegistrationState): Promise<SchedulerConfigurationReloadReport> {
    const reload = await state.registration.scheduler.reloadConfiguration();
    validateBound(reload.operationalPolicy.pollIntervalMs, `${state.registration.id}.pollIntervalMs`);
    validateBound(reload.operationalPolicy.drainTimeoutMs, `${state.registration.id}.drainTimeoutMs`);
    validateBound(reload.operationalPolicy.cancellationTimeoutMs, `${state.registration.id}.cancellationTimeoutMs`);
    state.operationalPolicy = Object.freeze({ ...reload.operationalPolicy });
    return reload;
  }
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
