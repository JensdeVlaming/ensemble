import type { RepositoryConfiguration, RoleDefinition, RuntimeResult, Task, TaskComment, Artifact, Workspace } from "../domain/model.ts";
import type { RepositoryConfigSource } from "./repository.ts";
import type { RuntimeEvent, RuntimeRegistry } from "../runtimes/runtime.ts";
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

export interface ExecutionEnvironment {
  readonly configuration: RepositoryConfiguration;
  run(request: RuntimeExecutionRequest): Promise<ExecutionReport>;
}

export interface TaskExecutionService {
  withEnvironment<T>(task: Task, work: (environment: ExecutionEnvironment) => Promise<T>): Promise<T>;
}

export type EventSink = (event: RuntimeEvent, task: Task) => void | Promise<void>;

export interface ConfigurationResolver {
  resolve(task: Task, workspace: Workspace): Promise<RepositoryConfiguration>;
}

export class WorkspaceConfigurationResolver implements ConfigurationResolver {
  readonly source: RepositoryConfigSource;
  constructor(source: RepositoryConfigSource) { this.source = source; }
  resolve(task: Task, workspace: Workspace): Promise<RepositoryConfiguration> {
    return this.source.load(task.repository, workspace.repositoryPath);
  }
}

/** Owns workspace allocation, runtime invocation, event streaming, and cleanup. */
export class ExecutionEngine implements TaskExecutionService {
  readonly runtimes: RuntimeRegistry;
  readonly workspaces: WorkspaceManager;
  readonly configurations: ConfigurationResolver;
  readonly events: EventSink;
  readonly failureDrainMs: number;

  constructor(
    runtimes: RuntimeRegistry,
    workspaces: WorkspaceManager,
    configurations: ConfigurationResolver,
    events: EventSink = () => undefined,
    failureDrainMs = 100,
  ) {
    this.runtimes = runtimes;
    this.workspaces = workspaces;
    this.configurations = configurations;
    this.events = events;
    this.failureDrainMs = failureDrainMs;
  }

  async withEnvironment<T>(task: Task, work: (environment: ExecutionEnvironment) => Promise<T>): Promise<T> {
    let workspace: Workspace | undefined;
    let open = true;
    let used = false;
    try {
      workspace = (await this.workspaces.restore(task)) ?? (await this.workspaces.create(task));
      const configuration = await this.configurations.resolve(task, workspace);
      const environment: ExecutionEnvironment = Object.freeze({
        configuration,
        run: async (request: RuntimeExecutionRequest) => {
          if (!open) throw new Error("Execution environment is closed");
          if (used) throw new Error("Execution environment is single-use");
          used = true;
          return this.#run(workspace!, configuration, request);
        },
      });
      return await work(environment);
    } finally {
      open = false;
      if (workspace) {
        // Workspace disposal is best-effort. Cleanup must never replace a
        // scheduling, provider, event-stream, or runtime outcome.
        await this.workspaces.cleanup(workspace).catch(() => undefined);
      }
    }
  }

  async #run(workspace: Workspace, configuration: RepositoryConfiguration, request: RuntimeExecutionRequest): Promise<ExecutionReport> {
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
    const session = await runtime.start(prepared);
    const resultPromise = session.result.then(validateRuntimeResult);
    const eventPump = (async () => {
      for await (const event of session.events) await this.events(event, request.task);
    })();
    const resultOutcome = resultPromise.then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "runtime_error" as const, error }),
    );
    const eventOutcome = eventPump.then(
      () => ({ kind: "events_done" as const }),
      (error: unknown) => ({ kind: "event_error" as const, error }),
    );
    const first = await Promise.race([resultOutcome, eventOutcome]);
    if (first.kind === "result") {
      const events = await eventOutcome;
      if (events.kind === "event_error") throw events.error;
      return report(request, first.result);
    }
    if (first.kind === "events_done") {
      const result = await resultOutcome;
      if (result.kind === "runtime_error") throw result.error;
      return report(request, result.result);
    }

    await runtime.cancel(session).catch(() => undefined);
    if (first.kind === "runtime_error") {
      void eventPump.catch(() => undefined);
      throw first.error;
    }

    // Give cancellation a bounded opportunity to surface the runtime's primary
    // failure. A non-cooperative result channel cannot hang the engine.
    const drained = await Promise.race([
      resultOutcome,
      delay(this.failureDrainMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (drained.kind === "runtime_error") throw drained.error;
    if (drained.kind === "result") throw first.error;
    void resultPromise.catch(() => undefined);
    throw first.error;
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
