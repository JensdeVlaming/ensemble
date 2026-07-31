import type { RepositoryConfiguration, RoleDefinition, RuntimeResult, Task, TaskComment, Artifact, Workspace } from "../domain/model.ts";
import type { RepositoryConfigSource } from "./repository.ts";
import type { Runtime, RuntimeEvent, RuntimeRegistry, RuntimeSession } from "../runtimes/runtime.ts";
import type { WorkspaceManager } from "./workspace.ts";

export interface RuntimeExecutionRequest {
  readonly task: Task;
  readonly role: RoleDefinition;
  readonly comments: readonly TaskComment[];
  readonly artifacts: readonly Artifact[];
  readonly executionId: string;
}

export interface ExecutionReport {
  readonly taskId: string;
  readonly role: string;
  readonly result: RuntimeResult;
  readonly executionId: string;
}

export type CancellationReason = "reconciliation" | "shutdown" | "timeout" | "stalled" | "operator";

export type RunningExecutionState = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface RunningExecutionSnapshot {
  readonly executionId: string;
  readonly taskId: string;
  readonly role: string;
  readonly runtimeSessionId: string;
  readonly workspacePath: string;
  readonly state: RunningExecutionState;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly finishedAt?: string;
  readonly cancellationReason?: CancellationReason;
}

export interface RunningExecution {
  readonly executionId: string;
  readonly result: Promise<ExecutionReport>;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  snapshot(): RunningExecutionSnapshot;
  cancel(reason: CancellationReason): Promise<void>;
}

export class ExecutionCancelledError extends Error {
  readonly reason: CancellationReason;

  constructor(reason: CancellationReason) {
    super(`Execution cancelled: ${reason}`);
    this.name = "ExecutionCancelledError";
    this.reason = reason;
  }
}

export interface ExecutionEnvironment {
  readonly configuration: RepositoryConfiguration;
  start(request: RuntimeExecutionRequest): Promise<RunningExecution>;
}

export interface ConfiguredExecution {
  readonly configuration: RepositoryConfiguration;
  withEnvironment<T>(work: (environment: ExecutionEnvironment) => Promise<T>): Promise<T>;
}

export interface TaskExecutionService {
  withConfiguration<T>(task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T>;
}

export type EventSink = (event: RuntimeEvent, task: Task) => void | Promise<void>;

export interface ConfigurationResolver {
  resolve(task: Task): Promise<RepositoryConfiguration>;
}

export class WorkspaceConfigurationResolver implements ConfigurationResolver {
  readonly source: RepositoryConfigSource;
  readonly repositoryPath: string | ((task: Task) => string | Promise<string>);

  constructor(source: RepositoryConfigSource, repositoryPath: string | ((task: Task) => string | Promise<string>)) {
    this.source = source;
    this.repositoryPath = repositoryPath;
  }

  async resolve(task: Task): Promise<RepositoryConfiguration> {
    const repositoryPath = typeof this.repositoryPath === "string" ? this.repositoryPath : await this.repositoryPath(task);
    return this.source.load(task.repository, repositoryPath);
  }
}

/** Owns workspace allocation, runtime invocation, event streaming, and cleanup. */
export class ExecutionEngine implements TaskExecutionService {
  readonly runtimes: RuntimeRegistry;
  readonly workspaces: WorkspaceManager;
  readonly configurations: ConfigurationResolver;
  readonly events: EventSink;
  readonly failureDrainMs: number;
  readonly now: () => string;

  constructor(
    runtimes: RuntimeRegistry,
    workspaces: WorkspaceManager,
    configurations: ConfigurationResolver,
    events: EventSink = () => undefined,
    failureDrainMs = 100,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.runtimes = runtimes;
    this.workspaces = workspaces;
    this.configurations = configurations;
    this.events = events;
    this.failureDrainMs = failureDrainMs;
    this.now = now;
  }

  async withConfiguration<T>(task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    const configuration = await this.configurations.resolve(task);
    let open = true;
    let used = false;
    const execution: ConfiguredExecution = Object.freeze({
      configuration,
      withEnvironment: async <TResult>(environmentWork: (environment: ExecutionEnvironment) => Promise<TResult>) => {
        if (!open) throw new Error("Configured execution is closed");
        if (used) throw new Error("Configured execution is single-use");
        used = true;
        return this.#withEnvironment(task, configuration, environmentWork);
      },
    });
    try {
      return await work(execution);
    } finally {
      open = false;
    }
  }

  withEnvironment<T>(task: Task, work: (environment: ExecutionEnvironment) => Promise<T>): Promise<T> {
    return this.withConfiguration(task, (execution) => execution.withEnvironment(work));
  }

  async #withEnvironment<T>(
    task: Task,
    configuration: RepositoryConfiguration,
    work: (environment: ExecutionEnvironment) => Promise<T>,
  ): Promise<T> {
    let workspace: Workspace | undefined;
    let open = true;
    let used = false;
    let cleanupTransferred = false;
    try {
      workspace = (await this.workspaces.restore(task)) ?? (await this.workspaces.create(task));
      const environment: ExecutionEnvironment = Object.freeze({
        configuration,
        start: async (request: RuntimeExecutionRequest) => {
          if (!open) throw new Error("Execution environment is closed");
          if (used) throw new Error("Execution environment is single-use");
          used = true;
          cleanupTransferred = true;
          return this.#start(workspace!, configuration, request);
        },
      });
      return await work(environment);
    } finally {
      open = false;
      if (workspace && !cleanupTransferred) {
        // Workspace disposal is best-effort. Cleanup must never replace a
        // scheduling, provider, event-stream, or runtime outcome.
        await this.workspaces.cleanup(workspace).catch(() => undefined);
      }
    }
  }

  async #start(workspace: Workspace, configuration: RepositoryConfiguration, request: RuntimeExecutionRequest): Promise<RunningExecution> {
    try {
      const runtime = this.runtimes.get(configuration.runtime.name);
      const prepared = await runtime.prepare({
        repository: request.task.repository,
        workspace,
        task: request.task,
        comments: request.comments,
        artifacts: request.artifacts,
        workflow: configuration.workflow,
        agents: configuration.agents,
        role: request.role,
        runtimeConfig: configuration.runtime.config,
      });
      const startedAt = this.now();
      const session = await runtime.start(prepared);
      return new LiveRunningExecution({
        runtime,
        session,
        workspace,
        request,
        events: this.events,
        cancellationMs: configuration.timeouts.cancellationMs,
        failureDrainMs: this.failureDrainMs,
        startedAt,
        now: this.now,
        cleanup: () => this.workspaces.cleanup(workspace),
      });
    } catch (error) {
      beginBestEffortCleanup(() => this.workspaces.cleanup(workspace));
      throw error;
    }
  }
}

type ResultOutcome =
  | { readonly kind: "result"; readonly result: RuntimeResult }
  | { readonly kind: "runtime_error"; readonly error: unknown };

type EventOutcome =
  | { readonly kind: "events_done" }
  | { readonly kind: "event_error"; readonly error: unknown };

interface LiveRunningExecutionOptions {
  readonly runtime: Runtime;
  readonly session: RuntimeSession;
  readonly workspace: Workspace;
  readonly request: RuntimeExecutionRequest;
  readonly events: EventSink;
  readonly cancellationMs: number;
  readonly failureDrainMs: number;
  readonly startedAt: string;
  readonly now: () => string;
  readonly cleanup: () => Promise<void>;
}

class LiveRunningExecution implements RunningExecution {
  readonly executionId: string;
  readonly result: Promise<ExecutionReport>;
  readonly startedAt: string;
  readonly #options: LiveRunningExecutionOptions;
  readonly #resultOutcome: Promise<ResultOutcome>;
  readonly #eventOutcome: Promise<EventOutcome>;
  readonly #cancellation: Promise<CancellationReason>;
  readonly #terminal: Promise<void>;
  #resolveCancellation!: (reason: CancellationReason) => void;
  #resolveTerminal!: () => void;
  #state: RunningExecutionState = "running";
  #lastActivityAt: string;
  #finishedAt?: string;
  #cancellationReason?: CancellationReason;
  #runtimeCancellation?: Promise<void>;
  #cancelCompletion?: Promise<void>;
  #cleanupStarted = false;

  constructor(options: LiveRunningExecutionOptions) {
    this.#options = options;
    this.executionId = options.request.executionId;
    this.startedAt = options.startedAt;
    this.#lastActivityAt = options.startedAt;
    this.#cancellation = new Promise((resolve) => { this.#resolveCancellation = resolve; });
    this.#terminal = new Promise((resolve) => { this.#resolveTerminal = resolve; });
    this.#resultOutcome = options.session.result.then(validateRuntimeResult).then(
      (result): ResultOutcome => ({ kind: "result", result }),
      (error: unknown): ResultOutcome => ({ kind: "runtime_error", error }),
    );
    this.#eventOutcome = this.#pumpEvents().then(
      (): EventOutcome => ({ kind: "events_done" }),
      (error: unknown): EventOutcome => ({ kind: "event_error", error }),
    );
    this.result = this.#settle().then(
      (value) => { this.#finish("completed"); return value; },
      (error: unknown) => {
        this.#finish(error instanceof ExecutionCancelledError ? "cancelled" : "failed");
        throw error;
      },
    );
    void this.result.catch(() => undefined);
  }

  get lastActivityAt(): string {
    return this.#lastActivityAt;
  }

  snapshot(): RunningExecutionSnapshot {
    return Object.freeze({
      executionId: this.executionId,
      taskId: this.#options.request.task.id,
      role: this.#options.request.role.name,
      runtimeSessionId: this.#options.session.id,
      workspacePath: this.#options.workspace.root,
      state: this.#state,
      startedAt: this.startedAt,
      lastActivityAt: this.#lastActivityAt,
      ...(this.#finishedAt ? { finishedAt: this.#finishedAt } : {}),
      ...(this.#cancellationReason ? { cancellationReason: this.#cancellationReason } : {}),
    });
  }

  cancel(reason: CancellationReason): Promise<void> {
    if (isTerminal(this.#state)) return Promise.resolve();
    if (!this.#cancellationReason) {
      this.#cancellationReason = reason;
      this.#state = "cancelling";
      this.#resolveCancellation(reason);
    }
    this.#cancelCompletion ??= Promise.all([this.#cancelRuntimeBounded(), this.#terminal]).then(() => undefined);
    return this.#cancelCompletion;
  }

  async #pumpEvents(): Promise<void> {
    for await (const event of this.#options.session.events) {
      if (isActivityEvent(event)) this.#lastActivityAt = this.#options.now();
      await this.#options.events(event, this.#options.request.task);
    }
  }

  async #settle(): Promise<ExecutionReport> {
    const first = await Promise.race([
      this.#resultOutcome.then((outcome) => ({ source: "result" as const, outcome })),
      this.#eventOutcome.then((outcome) => ({ source: "events" as const, outcome })),
      this.#cancellation.then((reason) => ({ source: "cancellation" as const, reason })),
    ]);

    if (first.source === "cancellation") {
      await this.#cancelRuntimeBounded();
      throw new ExecutionCancelledError(first.reason);
    }

    if (first.source === "result") {
      if (first.outcome.kind === "runtime_error") {
        await this.#cancelRuntimeBounded();
        throw first.outcome.error;
      }
      const events = await Promise.race([
        this.#eventOutcome,
        this.#cancellation.then((reason) => ({ kind: "cancelled" as const, reason })),
      ]);
      if (events.kind === "cancelled") {
        await this.#cancelRuntimeBounded();
        throw new ExecutionCancelledError(events.reason);
      }
      if (events.kind === "event_error") throw events.error;
      return report(this.#options.request, first.outcome.result);
    }

    if (first.outcome.kind === "events_done") {
      const result = await Promise.race([
        this.#resultOutcome,
        this.#cancellation.then((reason) => ({ kind: "cancelled" as const, reason })),
      ]);
      if (result.kind === "cancelled") {
        await this.#cancelRuntimeBounded();
        throw new ExecutionCancelledError(result.reason);
      }
      if (result.kind === "runtime_error") throw result.error;
      return report(this.#options.request, result.result);
    }

    await this.#cancelRuntimeBounded();
    const drained = await Promise.race([
      this.#resultOutcome,
      delay(this.#options.failureDrainMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (drained.kind === "runtime_error") throw drained.error;
    throw first.outcome.error;
  }

  #cancelRuntimeBounded(): Promise<void> {
    this.#runtimeCancellation ??= Promise.race([
      Promise.resolve().then(() => this.#options.runtime.cancel(this.#options.session)).then(
        () => undefined,
        () => undefined,
      ),
      delay(this.#options.cancellationMs),
    ]).then(() => undefined);
    return this.#runtimeCancellation;
  }

  #finish(state: "completed" | "failed" | "cancelled"): void {
    this.#state = state;
    this.#finishedAt = this.#options.now();
    this.#beginCleanup();
    this.#resolveTerminal();
  }

  #beginCleanup(): void {
    if (this.#cleanupStarted) return;
    this.#cleanupStarted = true;
    beginBestEffortCleanup(this.#options.cleanup);
  }
}

function isTerminal(state: RunningExecutionState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function isActivityEvent(event: RuntimeEvent): boolean {
  return event.type !== "run_started" && event.type !== "run_completed" && event.type !== "run_failed";
}

function beginBestEffortCleanup(cleanup: () => Promise<void>): void {
  try {
    void cleanup().catch(() => undefined);
  } catch {
    // Cleanup is secondary to the execution result and is always best-effort.
  }
}

function report(request: RuntimeExecutionRequest, result: RuntimeResult): ExecutionReport {
  return { taskId: request.task.id, role: request.role.name, result, executionId: request.executionId };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Compatibility wrapper for construction sites that prefer an explicit service. */
export class EngineExecutionService implements TaskExecutionService {
  readonly engine: ExecutionEngine;
  constructor(engine: ExecutionEngine) { this.engine = engine; }
  withConfiguration<T>(task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    return this.engine.withConfiguration(task, work);
  }
  withEnvironment<T>(task: Task, work: (environment: ExecutionEnvironment) => Promise<T>): Promise<T> {
    return this.engine.withEnvironment(task, work);
  }
}

export function validateRuntimeResult(value: RuntimeResult): RuntimeResult {
  if (!value || typeof value !== "object") throw new Error("Runtime returned no structured result");
  if (typeof value.outcome !== "string" || value.outcome.trim().length === 0) throw new Error("Runtime result requires outcome");
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) throw new Error("Runtime result requires summary");
  if (value.nextRole !== undefined && (typeof value.nextRole !== "string" || value.nextRole.trim().length === 0)) throw new Error("Runtime result nextRole is invalid");
  if (!Array.isArray(value.comments) || value.comments.some((item) => typeof item !== "string")) throw new Error("Runtime result comments are invalid");
  if (!Array.isArray(value.artifacts) || value.artifacts.some((item) => !item || typeof item.type !== "string" || !item.type.trim() || typeof item.url !== "string" || !item.url.trim())) {
    throw new Error("Runtime result artifacts are invalid");
  }
  return value;
}
