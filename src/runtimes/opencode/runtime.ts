import { randomUUID } from "node:crypto";
import type { ResumeContext, RuntimeContext, RuntimeResult, RuntimeTool } from "../../domain/model.ts";
import type { PreparedRun, Runtime, RuntimeEvent, RuntimeSession } from "../runtime.ts";

export interface OpenCodeRunRequest {
  readonly id: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly tools: readonly RuntimeTool[];
}

export interface OpenCodeTransportSession {
  readonly id: string;
  readonly messages: AsyncIterable<unknown>;
  readonly result: Promise<unknown>;
}

export interface OpenCodeTransport {
  validateConfiguration(config: Readonly<Record<string, unknown>>): void;
  diagnose(cwd: string): Promise<void>;
  start(request: OpenCodeRunRequest): Promise<OpenCodeTransportSession>;
  resume(session: OpenCodeTransportSession, prompt: string): Promise<OpenCodeTransportSession>;
  cancel(session: OpenCodeTransportSession): Promise<void>;
}

export class OpenCodeRuntime implements Runtime {
  readonly name: string;
  readonly transport: OpenCodeTransport;
  readonly #sessions = new WeakMap<RuntimeSession, OpenCodeSessionState>();

  constructor(transport: OpenCodeTransport, name = "opencode") {
    if (!name.trim()) throw new Error("OpenCode runtime name is required");
    this.transport = transport;
    this.name = name;
  }

  validateConfiguration(config: Readonly<Record<string, unknown>>): void {
    operatorRequestPolicy(config);
    this.transport.validateConfiguration(config);
  }

  diagnose(context: { readonly cwd: string }): Promise<void> {
    return this.transport.diagnose(context.cwd);
  }

  async prepare(context: RuntimeContext): Promise<PreparedRun> {
    return {
      id: randomUUID(),
      context,
      payload: buildPrompt(context),
      operatorRequests: operatorRequestPolicy(context.runtimeConfig),
    };
  }

  async start(prepared: PreparedRun): Promise<RuntimeSession> {
    if (typeof prepared.payload !== "string") throw new Error("OpenCode prepared payload must be a prompt string");
    const current = await this.transport.start({
      id: prepared.id,
      cwd: prepared.context.workspace.repositoryPath,
      prompt: prepared.payload,
      config: prepared.context.runtimeConfig,
      tools: prepared.context.tools,
    });
    return this.wrap({ current }, prepared.context.executionId);
  }

  async resume(session: RuntimeSession, context: ResumeContext): Promise<RuntimeSession> {
    const state = this.#sessions.get(session);
    if (!state) throw new Error(`Cannot resume unknown OpenCode session: ${session.id}`);
    state.current = await this.transport.resume(state.current, buildResumePrompt(context));
    return this.wrap(state, sessionExecutionId(session));
  }

  async cancel(session: RuntimeSession): Promise<void> {
    const state = this.#sessions.get(session);
    if (!state) return;
    this.#sessions.delete(session);
    await this.transport.cancel(state.current);
  }

  private wrap(state: OpenCodeSessionState, executionId: string): RuntimeSession {
    const result = deferred<RuntimeResult>();
    void result.promise.catch(() => undefined);
    const sessionId = state.current.id;
    const events = async function* (): AsyncIterable<RuntimeEvent> {
      yield { type: "run_started", at: new Date().toISOString(), executionId, sessionId };
      try {
        for await (const message of state.current.messages) {
          const event = parseEvent(message, executionId);
          if (event) yield event;
        }
        const completed = buildResult(await state.current.result);
        result.resolve(completed);
        yield { type: "run_completed", at: new Date().toISOString(), executionId, result: completed };
      } catch (error) {
        result.reject(error);
        yield { type: "run_failed", at: new Date().toISOString(), executionId,
          error: error instanceof Error ? error.message : "OpenCode runtime failed" };
      }
    };
    const session: RuntimeSession & { readonly executionId: string } = {
      id: sessionId, events: events(), result: result.promise, executionId,
    };
    this.#sessions.set(session, state);
    return session;
  }
}

interface OpenCodeSessionState { current: OpenCodeTransportSession }

function buildPrompt(context: RuntimeContext): string {
  return [
    "You are executing one role in an Ensemble software-engineering workflow.",
    "Follow AGENTS.md, the workflow, and role instructions in the context below.",
    "Use the available Ensemble MCP tools when provider context or lifecycle operations require them.",
    "Return the requested structured RuntimeResult with outcome, summary, optional nextRole, comments, and artifacts.",
    "",
    JSON.stringify({
      repository: context.repository,
      workspace: context.workspace,
      task: context.task,
      comments: context.comments,
      artifacts: context.artifacts,
      workflow: context.workflow.instructions,
      agents: context.agents,
      role: context.role,
      tools: context.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }, null, 2),
  ].join("\n");
}

function buildResumePrompt(context: ResumeContext): string {
  return [
    `Resume reason: ${context.reason}`,
    "New provider-visible context:",
    JSON.stringify({ comments: context.comments, artifacts: context.artifacts }, null, 2),
  ].join("\n");
}

function parseEvent(message: unknown, executionId: string): RuntimeEvent | undefined {
  if (!isRecord(message) || typeof message.type !== "string") return undefined;
  const at = typeof message.at === "string" ? message.at : new Date().toISOString();
  if (message.type === "heartbeat") return { type: "heartbeat", at, executionId };
  if (message.type === "progress_updated" && typeof message.message === "string") {
    return { type: "progress_updated", at, executionId, message: message.message };
  }
  if (message.type === "tool_started" && typeof message.tool === "string") {
    return { type: "tool_started", at, executionId, tool: message.tool };
  }
  if (message.type === "tool_finished" && typeof message.tool === "string" && typeof message.success === "boolean") {
    return { type: "tool_finished", at, executionId, tool: message.tool, success: message.success };
  }
  if (message.type === "usage_updated" && nonnegativeInteger(message.inputTokens)
    && nonnegativeInteger(message.outputTokens) && nonnegativeInteger(message.totalTokens)) {
    return { type: "usage_updated", at, executionId, inputTokens: message.inputTokens,
      outputTokens: message.outputTokens, totalTokens: message.totalTokens };
  }
  if ((message.type === "approval_requested" || message.type === "user_input_requested") && isRecord(message.request)) {
    const kind = message.type === "approval_requested" ? "approval" : "user_input";
    if (message.request.kind !== kind || typeof message.request.summary !== "string" || typeof message.request.createdAt !== "string") return undefined;
    return { type: message.type, at, executionId, request: { kind, summary: message.request.summary,
      ...(typeof message.request.requestId === "string" ? { requestId: message.request.requestId } : {}),
      createdAt: message.request.createdAt } };
  }
  return undefined;
}

function buildResult(value: unknown): RuntimeResult {
  if (!isRecord(value)) throw new Error("OpenCode returned no structured result");
  const allowed = new Set(["outcome", "summary", "nextRole", "comments", "artifacts"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`OpenCode result contains an unknown field: ${key}`);
  if (typeof value.outcome !== "string" || typeof value.summary !== "string") {
    throw new Error("OpenCode result requires string outcome and summary");
  }
  if (value.nextRole !== undefined && value.nextRole !== null && typeof value.nextRole !== "string") {
    throw new Error("OpenCode result nextRole must be a string");
  }
  if (!Array.isArray(value.comments) || value.comments.some((item) => typeof item !== "string")) {
    throw new Error("OpenCode result comments must be a string array");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.some((item) => !isArtifact(item))) {
    throw new Error("OpenCode result artifacts are invalid");
  }
  return {
    outcome: value.outcome,
    summary: value.summary,
    ...(typeof value.nextRole === "string" ? { nextRole: value.nextRole } : {}),
    comments: value.comments as string[],
    artifacts: (value.artifacts as Array<Record<string, unknown>>).map((artifact) => ({
      type: artifact.type as string,
      url: artifact.url as string,
      ...(typeof artifact.name === "string" ? { name: artifact.name } : {}),
      ...(isRecord(artifact.metadata) ? { metadata: artifact.metadata } : {}),
    })),
  };
}

function operatorRequestPolicy(config: Readonly<Record<string, unknown>>): "auto" | "reject" | "block" {
  const value = config.operatorRequests ?? "reject";
  if (value !== "auto" && value !== "reject" && value !== "block") throw new Error("Invalid OpenCode operatorRequests policy");
  return value;
}

function sessionExecutionId(session: RuntimeSession): string {
  const value = (session as RuntimeSession & { readonly executionId?: unknown }).executionId;
  if (typeof value !== "string" || !value) throw new Error(`OpenCode session has no execution ID: ${session.id}`);
  return value;
}

function isArtifact(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && typeof value.url === "string"
    && (value.name === undefined || value.name === null || typeof value.name === "string")
    && (value.metadata === undefined || value.metadata === null || isRecord(value.metadata));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error) { if (!settled) { settled = true; rejectPromise(error); } } };
}
