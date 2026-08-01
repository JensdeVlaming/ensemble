import { randomUUID } from "node:crypto";
import type { ResumeContext, RuntimeContext, RuntimeResult } from "../../domain/model.ts";
import type { PreparedRun, Runtime, RuntimeEvent, RuntimeSession } from "../runtime.ts";

export interface CodexRunRequest {
  readonly id: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface CodexTransportSession {
  readonly id: string;
  readonly messages: AsyncIterable<unknown>;
  readonly result: Promise<unknown>;
}

// The transport is the only surface that needs to understand a concrete Codex
// invocation (CLI, SDK, hosted process, or a future protocol).
export interface CodexTransport {
  start(request: CodexRunRequest): Promise<CodexTransportSession>;
  resume(session: CodexTransportSession, prompt: string): Promise<CodexTransportSession>;
  cancel(session: CodexTransportSession): Promise<void>;
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
  readonly #sessions = new WeakMap<RuntimeSession, CodexTransportSession>();

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
    });
    return this.wrap(transportSession, prepared.context.executionId);
  }

  async resume(session: RuntimeSession, context: ResumeContext): Promise<RuntimeSession> {
    const transportSession = this.#sessions.get(session);
    if (!transportSession) throw new Error(`Cannot resume unknown Codex session: ${session.id}`);
    return this.wrap(await this.transport.resume(transportSession, this.promptBuilder.buildResume(context)), sessionExecutionId(session));
  }

  async cancel(session: RuntimeSession): Promise<void> {
    const transportSession = this.#sessions.get(session);
    if (!transportSession) return;
    await this.transport.cancel(transportSession);
    this.#sessions.delete(session);
  }

  private wrap(transportSession: CodexTransportSession, executionId: string): RuntimeSession {
    const parser = this.eventParser;
    const result = transportSession.result.then((value) => this.resultBuilder.build(value));
    const messages = transportSession.messages;
    const events = async function* (): AsyncIterable<RuntimeEvent> {
      yield { type: "run_started", at: new Date().toISOString(), executionId, sessionId: transportSession.id };
      for await (const message of messages) {
        const event = parser.parse(message, executionId);
        if (event) yield event;
      }
      try {
        const completed = await result;
        yield { type: "run_completed", at: new Date().toISOString(), executionId, result: completed };
      } catch (error) {
        yield { type: "run_failed", at: new Date().toISOString(), executionId, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const session = { id: transportSession.id, events: events(), result, executionId } as RuntimeSession & { readonly executionId: string };
    this.#sessions.set(session, transportSession);
    return session;
  }
}

function codexOperatorRequestPolicy(config: Readonly<Record<string, unknown>>): "auto" | "reject" | "block" {
  const value = config.operatorRequests ?? "reject";
  if (value !== "auto" && value !== "reject" && value !== "block") throw new Error("Invalid Codex operatorRequests policy");
  return value;
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
