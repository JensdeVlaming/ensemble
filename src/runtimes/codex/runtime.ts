import { randomUUID } from "node:crypto";
import type { BlockingRequest, ResumeContext, RuntimeContext, RuntimeResult, RuntimeTool } from "../../domain/model.ts";
import type { PreparedRun, Runtime, RuntimeEvent, RuntimeSession } from "../runtime.ts";

export interface CodexRunRequest {
  readonly id: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly tools: readonly RuntimeTool[];
}

export interface CodexTransportSession {
  readonly id: string;
  readonly messages: AsyncIterable<unknown>;
  readonly result: Promise<unknown>;
}

// The transport is the only surface that needs to understand a concrete Codex
// invocation (CLI, SDK, hosted process, or a future protocol).
export interface CodexTransport {
  readonly defaultMaxTurns?: number;
  validateConfiguration?(config: Readonly<Record<string, unknown>>): void;
  start(request: CodexRunRequest): Promise<CodexTransportSession>;
  resume(session: CodexTransportSession, prompt: string): Promise<CodexTransportSession>;
  cancel(session: CodexTransportSession): Promise<void>;
  close?(session: CodexTransportSession): Promise<void>;
}

export class CodexContextBuilder {
  build(context: RuntimeContext): Readonly<Record<string, unknown>> {
    return {
      repository: context.repository,
      workspace: context.workspace,
      task: context.task,
      comments: context.comments,
      artifacts: context.artifacts,
      workflow: context.workflow.instructions,
      agents: context.agents,
      role: context.role,
      tools: context.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    };
  }
}

export class CodexPromptBuilder {
  build(context: Readonly<Record<string, unknown>>): string {
    return [
      "You are executing one role in an Ensemble software-engineering workflow.",
      "Follow AGENTS.md, the workflow, and role instructions in the context below.",
      "Return a structured RuntimeResult with outcome, summary, optional nextRole, comments, and artifacts.",
      "",
      JSON.stringify(context, null, 2),
    ].join("\n");
  }

  buildResume(context: ResumeContext): string {
    return [
      `Resume reason: ${context.reason}`,
      "New provider-visible context:",
      JSON.stringify({ comments: context.comments, artifacts: context.artifacts }, null, 2),
    ].join("\n");
  }
}

export class CodexEventParser {
  parse(message: unknown, executionId: string): RuntimeEvent | undefined {
    if (!isObject(message) || typeof message.type !== "string") return undefined;
    const at = typeof message.at === "string" ? message.at : new Date().toISOString();
    switch (message.type) {
      case "progress_updated":
        return typeof message.message === "string"
          ? { type: "progress_updated", at, executionId, message: message.message, percent: numberOrUndefined(message.percent) }
          : undefined;
      case "tool_started":
        return typeof message.tool === "string" ? { type: "tool_started", at, executionId, tool: message.tool } : undefined;
      case "tool_finished":
        return typeof message.tool === "string" && typeof message.success === "boolean"
          ? { type: "tool_finished", at, executionId, tool: message.tool, success: message.success }
          : undefined;
      case "validation_started":
        return typeof message.name === "string" ? { type: "validation_started", at, executionId, name: message.name } : undefined;
      case "validation_finished":
        return typeof message.name === "string" && typeof message.success === "boolean"
          ? { type: "validation_finished", at, executionId, name: message.name, success: message.success }
          : undefined;
      case "artifact_created":
        return isArtifact(message.artifact)
          ? { type: "artifact_created", at, executionId, artifact: message.artifact }
          : undefined;
      case "comment_requested":
        return typeof message.body === "string" ? { type: "comment_requested", at, executionId, body: message.body } : undefined;
      case "next_agent_requested":
        return typeof message.role === "string" ? { type: "next_agent_requested", at, executionId, role: message.role } : undefined;
      case "approval_requested": case "user_input_requested": case "tool_elicitation_requested":
        return isBlockingRequest(message.request) ? { type: message.type, at, executionId, request: message.request } : undefined;
      case "usage_updated":
        return nonnegativeInteger(message.inputTokens) && nonnegativeInteger(message.outputTokens) && nonnegativeInteger(message.totalTokens)
          ? { type: message.type, at, executionId, inputTokens: message.inputTokens,
            outputTokens: message.outputTokens, totalTokens: message.totalTokens }
          : undefined;
      case "rate_limit_updated":
        return typeof message.limitId === "string" ? { type: message.type, at, executionId, limitId: message.limitId,
          ...(typeof message.usedPercent === "number" ? { usedPercent: message.usedPercent } : {}),
          ...(typeof message.resetsAt === "string" ? { resetsAt: message.resetsAt } : {}) } : undefined;
      case "heartbeat": return { type: message.type, at, executionId };
      default:
        return undefined;
    }
  }
}

export class CodexResultBuilder {
  build(value: unknown): RuntimeResult {
    if (!isObject(value)) throw new Error("Codex returned no structured result");
    if (typeof value.outcome !== "string" || typeof value.summary !== "string") {
      throw new Error("Codex result requires string outcome and summary");
    }
    if (value.nextRole !== undefined && typeof value.nextRole !== "string") {
      throw new Error("Codex result nextRole must be a string");
    }
    if (!isStringArray(value.comments)) throw new Error("Codex result comments must be a string array");
    if (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifact)) {
      throw new Error("Codex result artifacts are invalid");
    }
    return {
      outcome: value.outcome,
      summary: value.summary,
      nextRole: value.nextRole,
      comments: value.comments,
      artifacts: value.artifacts,
    };
  }
}

export class CodexRuntime implements Runtime {
  readonly name: string;
  readonly #sessions = new WeakMap<RuntimeSession, CodexSessionState>();

  constructor(
    privateTransport: CodexTransport,
    privateContextBuilder = new CodexContextBuilder(),
    privatePromptBuilder = new CodexPromptBuilder(),
    privateEventParser = new CodexEventParser(),
    privateResultBuilder = new CodexResultBuilder(),
    name = "codex",
  ) {
    if (!name.trim()) throw new Error("Codex runtime name is required");
    this.name = name;
    this.transport = privateTransport;
    this.contextBuilder = privateContextBuilder;
    this.promptBuilder = privatePromptBuilder;
    this.eventParser = privateEventParser;
    this.resultBuilder = privateResultBuilder;
  }

  readonly transport: CodexTransport;
  readonly contextBuilder: CodexContextBuilder;
  readonly promptBuilder: CodexPromptBuilder;
  readonly eventParser: CodexEventParser;
  readonly resultBuilder: CodexResultBuilder;

  validateConfiguration(config: Readonly<Record<string, unknown>>): void {
    codexOperatorRequestPolicy(config);
    codexMaxTurns(config, this.transport.defaultMaxTurns ?? 1);
    this.transport.validateConfiguration?.(config);
  }

  async prepare(context: RuntimeContext): Promise<PreparedRun> {
    return {
      id: randomUUID(),
      context,
      payload: this.promptBuilder.build(this.contextBuilder.build(context)),
      operatorRequests: codexOperatorRequestPolicy(context.runtimeConfig),
    };
  }

  async start(prepared: PreparedRun): Promise<RuntimeSession> {
    if (typeof prepared.payload !== "string") throw new Error("Codex prepared payload must be a prompt string");
    const transportSession = await this.transport.start({
      id: prepared.id,
      cwd: prepared.context.workspace.repositoryPath,
      prompt: prepared.payload,
      config: prepared.context.runtimeConfig,
      tools: prepared.context.tools,
    });
    return this.wrap({ current: transportSession,
      maxTurns: codexMaxTurns(prepared.context.runtimeConfig, this.transport.defaultMaxTurns ?? 1), turnsUsed: 0 },
    prepared.context.executionId);
  }

  async resume(session: RuntimeSession, context: ResumeContext): Promise<RuntimeSession> {
    const state = this.#sessions.get(session);
    if (!state) throw new Error(`Cannot resume unknown Codex session: ${session.id}`);
    if (state.turnsUsed >= state.maxTurns) throw new Error(`Codex exhausted ${state.maxTurns} turns`);
    state.current = await this.transport.resume(state.current, this.promptBuilder.buildResume(context));
    return this.wrap(state, sessionExecutionId(session));
  }

  async cancel(session: RuntimeSession): Promise<void> {
    const state = this.#sessions.get(session);
    if (!state) return;
    await this.transport.cancel(state.current);
    this.#sessions.delete(session);
  }

  private wrap(state: CodexSessionState, executionId: string): RuntimeSession {
    const parser = this.eventParser;
    const resultBuilder = this.resultBuilder;
    const transport = this.transport;
    const result = deferredResult();
    void result.promise.catch(() => undefined);
    const sessionId = state.current.id;
    const events = async function* (): AsyncIterable<RuntimeEvent> {
      yield { type: "run_started", at: new Date().toISOString(), executionId, sessionId };
      while (state.turnsUsed < state.maxTurns) {
        state.turnsUsed += 1;
        const turn = state.turnsUsed;
        try {
          for await (const message of state.current.messages) {
            const event = parser.parse(message, executionId);
            if (event) yield event;
          }
          const raw = await state.current.result;
          try {
            const completed = resultBuilder.build(raw);
            result.resolve(completed);
            yield { type: "run_completed", at: new Date().toISOString(), executionId, result: completed };
            return;
          } catch (error) {
            if (turn >= state.maxTurns) throw new Error(`Codex exhausted ${state.maxTurns} turns without a valid structured result`, { cause: error });
            yield { type: "progress_updated", at: new Date().toISOString(), executionId,
              message: `Codex returned an invalid structured result; requesting correction (${turn + 1}/${state.maxTurns})` };
            state.current = await transport.resume(state.current, correctiveResultPrompt(error));
          }
        } catch (error) {
          result.reject(error);
          yield { type: "run_failed", at: new Date().toISOString(), executionId,
            error: error instanceof Error ? error.message : "Codex runtime failed" };
          return;
        }
      }
    };
    const session = { id: sessionId, events: events(), result: result.promise, executionId } as RuntimeSession & { readonly executionId: string };
    this.#sessions.set(session, state);
    return session;
  }
}

interface CodexSessionState { current: CodexTransportSession; readonly maxTurns: number; turnsUsed: number }

function codexOperatorRequestPolicy(config: Readonly<Record<string, unknown>>): "auto" | "reject" | "block" {
  const value = config.operatorRequests ?? "reject";
  if (value !== "auto" && value !== "reject" && value !== "block") throw new Error("Invalid Codex operatorRequests policy");
  return value;
}

function codexMaxTurns(config: Readonly<Record<string, unknown>>, fallback: number): number {
  const value = config.maxTurns ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new Error("Invalid Codex maxTurns policy");
  }
  return value as number;
}

function correctiveResultPrompt(error: unknown): string {
  const reason = error instanceof Error ? error.message : "invalid structured result";
  return [
    "Your previous response did not satisfy Ensemble's RuntimeResult contract.",
    `Validation failed: ${reason.slice(0, 1_024)}`,
    "Return only a structured result with outcome, summary, optional nextRole, comments, and artifacts.",
  ].join("\n");
}

interface ResultDeferred {
  readonly promise: Promise<RuntimeResult>;
  resolve(value: RuntimeResult): void;
  reject(error: unknown): void;
}

function deferredResult(): ResultDeferred {
  let settled = false;
  let resolvePromise!: (value: RuntimeResult) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<RuntimeResult>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error) { if (!settled) { settled = true; rejectPromise(error); } } };
}

function sessionExecutionId(session: RuntimeSession): string {
  const value = (session as RuntimeSession & { readonly executionId?: unknown }).executionId;
  if (typeof value !== "string" || !value) throw new Error(`Codex session has no execution ID: ${session.id}`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArtifact(value: unknown): value is RuntimeResult["artifacts"][number] {
  return isObject(value) && typeof value.type === "string" && typeof value.url === "string";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBlockingRequest(value: unknown): value is BlockingRequest {
  return isObject(value) && (value.kind === "approval" || value.kind === "user_input" || value.kind === "tool_elicitation")
    && typeof value.summary === "string" && typeof value.createdAt === "string"
    && (value.requestId === undefined || typeof value.requestId === "string");
}
