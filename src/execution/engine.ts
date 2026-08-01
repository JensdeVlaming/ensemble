import type { BlockingRequest, RepositoryConfiguration, RoleDefinition, RuntimeResult, RuntimeTool, Task, TaskComment, Artifact, Workspace } from "../domain/model.ts";
import { ConfigurationReloadError } from "./repository.ts";
import type {
  ConfigurationReloadResult,
  ConfigurationResolver,
  ReloadableConfigurationResolver,
  RepositoryConfigSource,
} from "./repository.ts";
import { validatePortableToolResult, validateRuntimeTools } from "../runtimes/runtime.ts";
import type { Runtime, RuntimeEvent, RuntimeRegistry, RuntimeSession } from "../runtimes/runtime.ts";
import type { WorkspaceManager } from "./workspace.ts";
import type { OperationalEvent, OperationalEventReporter } from "../domain/observability.ts";
import { emitOperational } from "../observability/logging.ts";

export type { ConfigurationResolver } from "./repository.ts";

export interface RuntimeExecutionRequest {
  readonly task: Task;
  readonly role: RoleDefinition;
  readonly comments: readonly TaskComment[];
  readonly artifacts: readonly Artifact[];
  readonly executionId: string;
  readonly tools?: readonly RuntimeTool[];
}

export interface CompletedExecutionReport {
  readonly kind: "completed";
  readonly taskId: string;
  readonly role: string;
  readonly result: RuntimeResult;
  readonly executionId: string;
}

export interface BlockedExecutionReport {
  readonly kind: "blocked";
  readonly taskId: string;
  readonly role: string;
  readonly executionId: string;
  readonly blockingRequest: BlockingRequest;
}

export type ExecutionReport = CompletedExecutionReport | BlockedExecutionReport;

export type CancellationReason = "reconciliation" | "shutdown" | "timeout" | "stalled" | "operator" | "lease_lost";

export type RunningExecutionState = "running" | "cancelling" | "completed" | "blocked" | "failed" | "cancelled";

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
  reloadConfiguration(): Promise<ConfigurationReloadResult>;
  withConfiguration<T>(task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T>;
}

export type EventSink = (event: RuntimeEvent, task: Task) => void | Promise<void>;

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
  readonly operationalEvents?: OperationalEventReporter;

  constructor(
    runtimes: RuntimeRegistry,
    workspaces: WorkspaceManager,
    configurations: ConfigurationResolver,
    events: EventSink = () => undefined,
    failureDrainMs = 100,
    now: () => string = () => new Date().toISOString(),
    operationalEvents?: OperationalEventReporter,
  ) {
    this.runtimes = runtimes;
    this.workspaces = workspaces;
    this.configurations = configurations;
    this.events = events;
    this.failureDrainMs = failureDrainMs;
    this.now = now;
    this.operationalEvents = operationalEvents;
  }

  reloadConfiguration(): Promise<ConfigurationReloadResult> {
    if (!isReloadableConfigurationResolver(this.configurations)) {
      return Promise.reject(new ConfigurationReloadError("Execution configuration source does not support reload"));
    }
    return this.configurations.reload((configuration) => this.#validateConfiguration(configuration));
  }

  async withConfiguration<T>(task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    this.#emit(task, { level: "debug", event: "configuration.resolve_started" });
    let configuration: RepositoryConfiguration;
    try {
      configuration = await this.configurations.resolve(task);
      this.#validateConfiguration(configuration);
      this.#emit(task, { level: "info", event: "configuration.resolve_completed" });
    } catch (error) {
      this.#emit(task, { level: "error", event: "configuration.resolve_failed", data: { errorCategory: "configuration" } });
      throw error;
    }
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
      this.#emit(task, { level: "debug", event: "workspace.restore_started" });
      workspace = await this.workspaces.restore(task);
      if (workspace) this.#emit(task, { level: "info", event: "workspace.restored", data: { restored: true } });
      else {
        this.#emit(task, { level: "debug", event: "workspace.create_started" });
        workspace = await this.workspaces.create(task);
        this.#emit(task, { level: "info", event: "workspace.created", data: { restored: false } });
      }
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
    } catch (error) {
      if (!workspace) this.#emit(task, { level: "error", event: "workspace.allocation_failed", data: { errorCategory: "unexpected" } });
      throw error;
    } finally {
      open = false;
      if (workspace && !cleanupTransferred) {
        // Workspace disposal is best-effort. Cleanup must never replace a
        // scheduling, provider, event-stream, or runtime outcome.
        await this.#cleanup(task, workspace).catch(() => undefined);
      }
    }
  }

  async #start(workspace: Workspace, configuration: RepositoryConfiguration, request: RuntimeExecutionRequest): Promise<RunningExecution> {
    try {
      const runtime = this.runtimes.get(configuration.runtime.name);
      this.#emit(request.task, contextEvent(request, "runtime.prepare_started", "debug"));
      const prepared = await runtime.prepare({
        executionId: request.executionId,
        repository: request.task.repository,
        workspace,
        task: request.task,
        comments: request.comments,
        artifacts: request.artifacts,
        workflow: configuration.workflow,
        agents: configuration.agents,
        role: request.role,
        runtimeConfig: configuration.runtime.config,
        tools: validateRuntimeTools(request.tools ?? []),
      });
      this.#emit(request.task, contextEvent(request, "runtime.prepared", "info"));
      const startedAt = this.now();
      this.#emit(request.task, contextEvent(request, "runtime.start_started", "debug"));
      const session = await startRuntimeWithin(runtime, prepared, configuration.timeouts.runtimeStartMs);
      this.#emit(request.task, contextEvent(request, "runtime.started", "info"));
      return new LiveRunningExecution({
        runtime,
        session,
        workspace,
        request,
        events: this.events,
        cancellationMs: configuration.timeouts.cancellationMs,
        failureDrainMs: this.failureDrainMs,
        operatorRequests: prepared.operatorRequests,
        startedAt,
        now: this.now,
        operationalEvents: this.operationalEvents,
        cleanup: () => this.#cleanup(request.task, workspace),
      });
    } catch (error) {
      this.#emit(request.task, { ...contextEvent(request, "runtime.failed", "error"), data: { errorCategory: "runtime" } });
      beginBestEffortCleanup(() => this.#cleanup(request.task, workspace));
      throw error;
    }
  }

  async #cleanup(task: Task, workspace: Workspace): Promise<void> {
    this.#emit(task, { level: "debug", event: "workspace.cleanup_started" });
    try {
      await this.workspaces.cleanup(workspace);
      this.#emit(task, { level: "info", event: "workspace.cleanup_completed" });
    } catch (error) {
      this.#emit(task, { level: "warn", event: "workspace.cleanup_failed", data: { errorCategory: "cleanup" } });
      throw error;
    }
  }

  #emit(task: Task, event: Omit<OperationalEvent, "repositoryId" | "taskId">): void {
    emitOperational(this.operationalEvents, { ...event, repositoryId: task.repository.id, taskId: task.id });
  }

  #validateConfiguration(configuration: RepositoryConfiguration): void {
    const runtime = this.runtimes.get(configuration.runtime.name);
    runtime.validateConfiguration?.(configuration.runtime.config);
  }
}

async function startRuntimeWithin(runtime: Runtime, prepared: Parameters<Runtime["start"]>[0], timeoutMs: number): Promise<RuntimeSession> {
  const starting = runtime.start(prepared);
  if (timeoutMs === 0) {
    void starting.then((late) => runtime.cancel(late)).catch(() => undefined);
    throw new Error("Runtime start timed out");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      starting,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Runtime start timed out")), timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "Runtime start timed out") {
      void starting.then((late) => runtime.cancel(late)).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ResultOutcome =
  | { readonly kind: "result"; readonly result: RuntimeResult }
  | { readonly kind: "runtime_error"; readonly error: unknown };

type EventOutcome =
  | { readonly kind: "events_done" }
  | { readonly kind: "event_error"; readonly error: unknown };

type BlockingOutcome = { readonly request: BlockingRequest };

interface LiveRunningExecutionOptions {
  readonly runtime: Runtime;
  readonly session: RuntimeSession;
  readonly workspace: Workspace;
  readonly request: RuntimeExecutionRequest;
  readonly events: EventSink;
  readonly cancellationMs: number;
  readonly failureDrainMs: number;
  readonly operatorRequests: unknown;
  readonly startedAt: string;
  readonly now: () => string;
  readonly cleanup: () => Promise<void>;
  readonly operationalEvents?: OperationalEventReporter;
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
  readonly #blocking: Promise<BlockingOutcome>;
  #resolveCancellation!: (reason: CancellationReason) => void;
  #resolveTerminal!: () => void;
  #resolveBlocking!: (outcome: BlockingOutcome) => void;
  #state: RunningExecutionState = "running";
  #lastActivityAt: string;
  #finishedAt?: string;
  #cancellationReason?: CancellationReason;
  #runtimeCancellation?: Promise<void>;
  #cancelCompletion?: Promise<void>;
  #cleanupStarted = false;
  #blockingObserved = false;

  constructor(options: LiveRunningExecutionOptions) {
    this.#options = options;
    this.executionId = options.request.executionId;
    this.startedAt = options.startedAt;
    this.#lastActivityAt = options.startedAt;
    this.#cancellation = new Promise((resolve) => { this.#resolveCancellation = resolve; });
    this.#terminal = new Promise((resolve) => { this.#resolveTerminal = resolve; });
    this.#blocking = new Promise((resolve) => { this.#resolveBlocking = resolve; });
    this.#resultOutcome = options.session.result.then(validateRuntimeResult).then(
      (result): ResultOutcome => ({ kind: "result", result }),
      (error: unknown): ResultOutcome => ({ kind: "runtime_error", error }),
    );
    this.#eventOutcome = this.#pumpEvents().then(
      (): EventOutcome => ({ kind: "events_done" }),
      (error: unknown): EventOutcome => ({ kind: "event_error", error }),
    );
    this.result = this.#settle().then(
      (value) => { this.#finish(value.kind === "blocked" ? "blocked" : "completed"); return value; },
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
      this.#emit("runtime.cancellation_started", "info", { reason });
      this.#cancellationReason = reason;
      this.#state = "cancelling";
      this.#resolveCancellation(reason);
    }
    this.#cancelCompletion ??= Promise.all([this.#cancelRuntimeBounded(), this.#terminal]).then(() => {
      this.#emit("runtime.cancellation_completed", "info", { reason: this.#cancellationReason ?? reason });
    });
    return this.#cancelCompletion;
  }

  async #pumpEvents(): Promise<void> {
    for await (const untrusted of this.#options.session.events) {
      const event = normalizeRuntimeEvent(untrusted, this.executionId);
      if (isActivityEvent(event)) this.#lastActivityAt = this.#options.now();
      const request = blockingRequest(event);
      if (request && !this.#blockingObserved) {
        if (this.#options.operatorRequests !== "block") {
          throw new Error("Runtime emitted an unresolved operator request without block policy");
        }
        this.#blockingObserved = true;
        this.#resolveBlocking({ request });
      }
      this.#emit("runtime.event", "debug", runtimeEventData(event));
      await this.#options.events(event, this.#options.request.task);
    }
  }

  async #settle(): Promise<ExecutionReport> {
    const first = await Promise.race([
      this.#resultOutcome.then((outcome) => ({ source: "result" as const, outcome })),
      this.#eventOutcome.then((outcome) => ({ source: "events" as const, outcome })),
      this.#cancellation.then((reason) => ({ source: "cancellation" as const, reason })),
      this.#blocking.then((outcome) => ({ source: "blocking" as const, outcome })),
    ]);

    if (first.source === "blocking") {
      this.#cancellationReason = "operator";
      this.#state = "cancelling";
      await this.#cancelRuntimeBounded();
      return blockedReport(this.#options.request, first.outcome.request);
    }

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
        this.#blocking.then((outcome) => ({ kind: "blocked" as const, outcome })),
      ]);
      if (events.kind === "blocked") {
        this.#cancellationReason = "operator";
        this.#state = "cancelling";
        await this.#cancelRuntimeBounded();
        return blockedReport(this.#options.request, events.outcome.request);
      }
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
        this.#blocking.then((outcome) => ({ kind: "blocked" as const, outcome })),
      ]);
      if (result.kind === "blocked") {
        this.#cancellationReason = "operator";
        this.#state = "cancelling";
        await this.#cancelRuntimeBounded();
        return blockedReport(this.#options.request, result.outcome.request);
      }
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

  #finish(state: "completed" | "blocked" | "failed" | "cancelled"): void {
    this.#state = state;
    this.#finishedAt = this.#options.now();
    this.#beginCleanup();
    this.#emit(state === "completed" ? "runtime.completed" : state === "blocked" ? "runtime.blocked" : "runtime.failed",
      state === "completed" ? "info" : state === "blocked" ? "warn" : "error",
      state === "completed" ? { success: true } : state === "blocked" ? { reason: "operator" }
        : { errorCategory: state === "cancelled" ? "cancelled" : "runtime" });
    this.#resolveTerminal();
  }

  #emit(event: OperationalEvent["event"], level: OperationalEvent["level"], data?: OperationalEvent["data"]): void {
    const request = this.#options.request;
    emitOperational(this.#options.operationalEvents, { level, event, repositoryId: request.task.repository.id,
      taskId: request.task.id, role: request.role.name, executionId: request.executionId, ...(data ? { data } : {}) });
  }

  #beginCleanup(): void {
    if (this.#cleanupStarted) return;
    this.#cleanupStarted = true;
    beginBestEffortCleanup(this.#options.cleanup);
  }
}

function isTerminal(state: RunningExecutionState): boolean {
  return state === "completed" || state === "blocked" || state === "failed" || state === "cancelled";
}

function isActivityEvent(event: RuntimeEvent): boolean {
  return event.type !== "run_started" && event.type !== "run_completed" && event.type !== "run_failed"
    && event.type !== "usage_updated" && event.type !== "rate_limit_updated";
}

function blockingRequest(event: RuntimeEvent): BlockingRequest | undefined {
  return event.type === "approval_requested" || event.type === "user_input_requested"
    || event.type === "tool_elicitation_requested" ? event.request : undefined;
}

function normalizeRuntimeEvent(value: unknown, executionId: string): RuntimeEvent {
  if (!isPlainRecord(value) || typeof value.type !== "string") throw new Error("Runtime event is invalid");
  if (typeof value.executionId !== "string" || !value.executionId || Buffer.byteLength(value.executionId, "utf8") > 256
    || value.executionId !== executionId) throw new Error("Runtime event execution ID mismatch");
  const at = normalizedTimestamp(value.at, "Runtime event timestamp is invalid");
  const base = { at, executionId };
  switch (value.type) {
    case "run_started":
      exactKeys(value, ["type", "at", "executionId", "sessionId"]);
      return { ...base, type: value.type, sessionId: eventText(value.sessionId, 256) };
    case "progress_updated":
      exactKeys(value, ["type", "at", "executionId", "message", "percent"]);
      if (value.percent !== undefined && (!Number.isFinite(value.percent) || (value.percent as number) < 0 || (value.percent as number) > 100)) {
        throw new Error("Runtime progress percent is invalid");
      }
      return { ...base, type: value.type, message: eventText(value.message, 2_048),
        ...(value.percent === undefined ? {} : { percent: value.percent as number }) };
    case "tool_started": case "tool_finished": {
      exactKeys(value, ["type", "at", "executionId", "tool", "success"]);
      const tool = eventText(value.tool, 256);
      if (value.type === "tool_started") {
        if (value.success !== undefined) throw new Error("Runtime tool-start event is invalid");
        return { ...base, type: value.type, tool };
      }
      if (typeof value.success !== "boolean") throw new Error("Runtime tool-finish event is invalid");
      return { ...base, type: value.type, tool, success: value.success };
    }
    case "validation_started": case "validation_finished": {
      exactKeys(value, ["type", "at", "executionId", "name", "success"]);
      const name = eventText(value.name, 256);
      if (value.type === "validation_started") {
        if (value.success !== undefined) throw new Error("Runtime validation-start event is invalid");
        return { ...base, type: value.type, name };
      }
      if (typeof value.success !== "boolean") throw new Error("Runtime validation-finish event is invalid");
      return { ...base, type: value.type, name, success: value.success };
    }
    case "artifact_created":
      exactKeys(value, ["type", "at", "executionId", "artifact"]);
      return { ...base, type: value.type, artifact: normalizeArtifact(value.artifact) };
    case "comment_requested":
      exactKeys(value, ["type", "at", "executionId", "body"]);
      return { ...base, type: value.type, body: eventText(value.body, 8_192) };
    case "next_agent_requested":
      exactKeys(value, ["type", "at", "executionId", "role"]);
      return { ...base, type: value.type, role: eventText(value.role, 256) };
    case "run_completed":
      exactKeys(value, ["type", "at", "executionId", "result"]);
      return { ...base, type: value.type, result: validateRuntimeResult(value.result as RuntimeResult) };
    case "run_failed":
      exactKeys(value, ["type", "at", "executionId", "error"]);
      return { ...base, type: value.type, error: eventText(value.error, 2_048) };
    case "approval_requested": case "user_input_requested": case "tool_elicitation_requested": {
      exactKeys(value, ["type", "at", "executionId", "request"]);
      const expected = value.type === "approval_requested" ? "approval"
        : value.type === "user_input_requested" ? "user_input" : "tool_elicitation";
      return { ...base, type: value.type, request: normalizeBlockingRequest(value.request, expected) } as RuntimeEvent;
    }
    case "usage_updated":
      exactKeys(value, ["type", "at", "executionId", "inputTokens", "outputTokens", "totalTokens"]);
      if (![value.inputTokens, value.outputTokens, value.totalTokens].every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
        || (value.totalTokens as number) < (value.inputTokens as number) + (value.outputTokens as number)) {
        throw new Error("Runtime usage event is invalid");
      }
      return { ...base, type: value.type, inputTokens: value.inputTokens as number,
        outputTokens: value.outputTokens as number, totalTokens: value.totalTokens as number };
    case "rate_limit_updated":
      exactKeys(value, ["type", "at", "executionId", "limitId", "usedPercent", "resetsAt"]);
      if (value.usedPercent !== undefined && (!Number.isFinite(value.usedPercent)
        || (value.usedPercent as number) < 0 || (value.usedPercent as number) > 100)) throw new Error("Runtime rate-limit event is invalid");
      return { ...base, type: value.type, limitId: eventText(value.limitId, 256),
        ...(value.usedPercent === undefined ? {} : { usedPercent: value.usedPercent as number }),
        ...(value.resetsAt === undefined ? {} : { resetsAt: normalizedTimestamp(value.resetsAt, "Runtime rate-limit event is invalid") }) };
    case "heartbeat":
      exactKeys(value, ["type", "at", "executionId"]);
      return { ...base, type: value.type };
    default: throw new Error("Runtime event type is unsupported");
  }
}

function normalizeBlockingRequest(value: unknown, kind: BlockingRequest["kind"]): BlockingRequest {
  if (!isPlainRecord(value)) throw new Error("Runtime blocking request is invalid");
  exactKeys(value, ["kind", "summary", "requestId", "createdAt"]);
  if (value.kind !== kind) throw new Error("Runtime blocking request kind is invalid");
  return Object.freeze({ kind, summary: eventText(value.summary, 2_048),
    ...(value.requestId === undefined ? {} : { requestId: eventText(value.requestId, 256) }),
    createdAt: normalizedTimestamp(value.createdAt, "Runtime blocking request timestamp is invalid") });
}

function normalizeArtifact(value: unknown): Artifact {
  if (!isPlainRecord(value)) throw new Error("Runtime artifact is invalid");
  exactKeys(value, ["type", "url", "name", "metadata"]);
  const metadata = value.metadata === undefined ? undefined : validatePortableToolResult(value.metadata);
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new Error("Runtime artifact metadata is invalid");
  }
  return Object.freeze({ type: eventText(value.type, 256), url: eventText(value.url, 4_096),
    ...(value.name === undefined ? {} : { name: eventText(value.name, 512) }),
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }) });
}

function eventText(value: unknown, bytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > bytes) {
    throw new Error("Runtime event text is invalid");
  }
  return value;
}

function normalizedTimestamp(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error(message);
  return new Date(epoch).toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || !accepted.has(key)) throw new Error("Runtime event has undeclared fields");
}

function contextEvent(
  request: RuntimeExecutionRequest,
  event: OperationalEvent["event"],
  level: OperationalEvent["level"],
): Omit<OperationalEvent, "repositoryId" | "taskId"> {
  return { level, event, role: request.role.name, executionId: request.executionId };
}

function runtimeEventData(event: RuntimeEvent): OperationalEvent["data"] {
  if (event.type === "tool_finished" || event.type === "validation_finished") {
    return { runtimeEventType: event.type, success: event.success };
  }
  if (event.type === "progress_updated" && event.percent !== undefined) {
    return { runtimeEventType: event.type, status: "active" };
  }
  return { runtimeEventType: event.type };
}

function beginBestEffortCleanup(cleanup: () => Promise<void>): void {
  try {
    void cleanup().catch(() => undefined);
  } catch {
    // Cleanup is secondary to the execution result and is always best-effort.
  }
}

function report(request: RuntimeExecutionRequest, result: RuntimeResult): ExecutionReport {
  return { kind: "completed", taskId: request.task.id, role: request.role.name, result, executionId: request.executionId };
}

function blockedReport(request: RuntimeExecutionRequest, blocking: BlockingRequest): BlockedExecutionReport {
  return { kind: "blocked", taskId: request.task.id, role: request.role.name, executionId: request.executionId,
    blockingRequest: Object.freeze({ ...blocking }) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Compatibility wrapper for construction sites that prefer an explicit service. */
export class EngineExecutionService implements TaskExecutionService {
  readonly engine: ExecutionEngine;
  constructor(engine: ExecutionEngine) { this.engine = engine; }
  reloadConfiguration(): Promise<ConfigurationReloadResult> { return this.engine.reloadConfiguration(); }
  withConfiguration<T>(task: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    return this.engine.withConfiguration(task, work);
  }
  withEnvironment<T>(task: Task, work: (environment: ExecutionEnvironment) => Promise<T>): Promise<T> {
    return this.engine.withEnvironment(task, work);
  }
}

function isReloadableConfigurationResolver(value: ConfigurationResolver): value is ReloadableConfigurationResolver {
  return "reload" in value && typeof value.reload === "function";
}

export function validateRuntimeResult(value: RuntimeResult): RuntimeResult {
  if (!isPlainRecord(value)) throw new Error("Runtime returned no structured result");
  exactKeys(value, ["outcome", "summary", "nextRole", "comments", "artifacts"]);
  const outcome = eventText(value.outcome, 256);
  const summary = eventText(value.summary, 8_192);
  const nextRole = value.nextRole === undefined ? undefined : eventText(value.nextRole, 256);
  if (!Array.isArray(value.comments) || value.comments.length > 100) throw new Error("Runtime result comments are invalid");
  const comments = value.comments.map((item) => eventText(item, 8_192));
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 100) throw new Error("Runtime result artifacts are invalid");
  const artifacts = value.artifacts.map(normalizeArtifact);
  return Object.freeze({ outcome, summary, ...(nextRole === undefined ? {} : { nextRole }),
    comments: Object.freeze(comments), artifacts: Object.freeze(artifacts) });
}
