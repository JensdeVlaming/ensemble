import { spawn } from "node:child_process";
import type { PortableJsonValue, RuntimeTool } from "../../domain/model.ts";
import { validatePortableToolResult } from "../runtime.ts";
import type { CodexRunRequest, CodexTransport, CodexTransportSession } from "./runtime.ts";

const MAX_LINE_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 1_024;
const MAX_BUFFERED_MESSAGES = 4_096;

export interface AppServerWritable {
  write(value: string): boolean;
}

export interface CodexAppServerProcess {
  readonly stdin: AppServerWritable;
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface CodexAppServerLauncher {
  launch(executable: string, arguments_: readonly string[], options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }): CodexAppServerProcess;
}

export class NodeCodexAppServerLauncher implements CodexAppServerLauncher {
  launch(executable: string, arguments_: readonly string[], options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }): CodexAppServerProcess {
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: { ...options.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < 8_192) stderr += chunk;
    });
    const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0 || signal === "SIGTERM") resolve({ code, signal });
        else reject(new Error(`Codex App Server failed (${signal ?? code ?? "unknown"}): ${boundedUtf8(stderr.trim(), 2_048)}`));
      });
    });
    return { stdin: child.stdin, stdout: child.stdout, exit, kill: (signal = "SIGTERM") => { child.kill(signal); } };
  }
}

export interface CodexAppServerTransportOptions {
  readonly executable?: string;
  readonly launcher?: CodexAppServerLauncher;
  readonly environment?: Readonly<Record<string, string>>;
  readonly arguments?: readonly string[];
  readonly requestTimeoutMs?: number;
}

interface ActiveTurn {
  readonly messages: MessageQueue;
  readonly result: Deferred<unknown>;
  turnId?: string;
  finalMessage?: string;
}

interface AppServerThread {
  readonly process: CodexAppServerProcess;
  readonly connection: JsonRpcConnection;
  readonly threadId: string;
  readonly cwd: string;
  readonly config: AppServerConfig;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  active?: ActiveTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export class CodexAppServerTransport implements CodexTransport {
  readonly defaultMaxTurns = 3;
  readonly executable: string;
  readonly launcher: CodexAppServerLauncher;
  readonly environment: Readonly<Record<string, string>>;
  readonly arguments: readonly string[];
  readonly requestTimeoutMs: number;
  readonly #sessions = new WeakMap<CodexTransportSession, AppServerThread>();

  constructor(options: CodexAppServerTransportOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.launcher = options.launcher ?? new NodeCodexAppServerLauncher();
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    this.arguments = Object.freeze([...(options.arguments ?? ["app-server", "--listen", "stdio://"])]);
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 30_000, "Codex App Server request timeout");
  }

  validateConfiguration(value: Readonly<Record<string, unknown>>): void { appServerConfig(value); }

  async start(request: CodexRunRequest): Promise<CodexTransportSession> {
    const config = appServerConfig(request.config);
    const process = this.launcher.launch(this.executable, this.arguments, {
      cwd: request.cwd,
      environment: this.environment,
    });
    let thread: AppServerThread | undefined;
    const connection = new JsonRpcConnection(process, this.requestTimeoutMs,
      async (message) => this.#receive(thread, message),
      (error) => { if (thread) this.#close(thread, error); });
    try {
      await connection.request("initialize", {
        clientInfo: { name: "ensemble", title: "Ensemble", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      });
      connection.notify("initialized", {});
      const started = requireRecord(await connection.request("thread/start", threadStartParams(request, config)));
      const threadId = nestedString(started, "thread", "id");
      thread = { process, connection, threadId, cwd: request.cwd, config,
        tools: new Map(request.tools.map((tool) => [tool.name, tool])), closed: false };
      const activeThread = thread;
      void process.exit.then(
        () => this.#close(activeThread, new Error("Codex App Server exited")),
        (error: unknown) => this.#close(activeThread, error),
      );
      return await this.#startTurn(activeThread, request.prompt);
    } catch (error) {
      process.kill("SIGTERM");
      connection.close(error);
      throw error;
    }
  }

  async resume(session: CodexTransportSession, prompt: string): Promise<CodexTransportSession> {
    const thread = this.#sessions.get(session);
    if (!thread || thread.closed) throw new Error("Cannot resume an unknown or closed Codex App Server thread");
    if (thread.active) throw new Error("Cannot resume an active Codex App Server turn");
    return this.#startTurn(thread, prompt);
  }

  async cancel(session: CodexTransportSession): Promise<void> {
    const thread = this.#sessions.get(session);
    if (!thread || thread.closed) return;
    const turnId = thread.active?.turnId;
    if (turnId) {
      await thread.connection.request("turn/interrupt", { threadId: thread.threadId, turnId }).catch(() => undefined);
    }
    this.#close(thread, new Error("Codex App Server turn cancelled"));
    await thread.process.exit.catch(() => undefined);
  }

  async close(session: CodexTransportSession): Promise<void> {
    const thread = this.#sessions.get(session);
    if (!thread || thread.closed) return;
    this.#close(thread, new Error("Codex App Server thread closed"));
    await thread.process.exit.catch(() => undefined);
  }

  async #startTurn(thread: AppServerThread, prompt: string): Promise<CodexTransportSession> {
    if (thread.active) throw new Error("Codex App Server thread already has an active turn");
    if (thread.idleTimer) { clearTimeout(thread.idleTimer); thread.idleTimer = undefined; }
    const active: ActiveTurn = { messages: new MessageQueue(), result: deferred<unknown>() };
    void active.result.promise.catch(() => undefined);
    thread.active = active;
    try {
      const response = requireRecord(await thread.connection.request("turn/start", turnStartParams(thread, prompt)));
      const turnId = nestedString(response, "turn", "id");
      if (active.turnId && active.turnId !== turnId) throw new Error("Codex App Server turn correlation mismatch");
      active.turnId = turnId;
      const session = Object.freeze({ id: thread.threadId, messages: active.messages,
        result: active.result.promise, cwd: thread.cwd, turnId }) as CodexTransportSession & { readonly cwd: string; readonly turnId: string };
      this.#sessions.set(session, thread);
      return session;
    } catch (error) {
      thread.active = undefined;
      active.messages.fail(error);
      active.result.reject(error);
      throw error;
    }
  }

  async #receive(thread: AppServerThread | undefined, message: JsonRpcInbound): Promise<unknown> {
    if (!thread) return {};
    if (message.id !== undefined) return this.#serverRequest(thread, message);
    const active = thread.active;
    if (!active || typeof message.method !== "string") return {};
    const params = requireRecord(message.params ?? {});
    if (message.method === "turn/started") {
      assertCorrelation(params, thread.threadId, undefined, true, false);
      const turnId = nestedString(params, "turn", "id");
      if (active.turnId && active.turnId !== turnId) throw new Error("Codex App Server turn correlation mismatch");
      active.turnId = turnId;
      return {};
    }
    if (message.method === "account/rateLimits/updated") {
      for (const event of rateLimitEvents(params)) active.messages.push(event);
      return {};
    }
    const requiresTurn = message.method !== "turn/completed";
    assertCorrelation(params, thread.threadId, active.turnId, true, requiresTurn);
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = requireRecord(params.item);
      if (item.type === "agentMessage" && message.method === "item/completed" && typeof item.text === "string") {
        active.finalMessage = item.text;
      }
      const normalized = itemEvent(message.method, item);
      if (normalized) active.messages.push(normalized);
    } else if (message.method === "thread/tokenUsage/updated") {
      const usage = usageEvent(params);
      if (usage) active.messages.push(usage);
    } else if (isActivityDelta(message.method)) {
      if (typeof params.delta !== "string") throw new Error("Codex App Server activity delta is invalid");
      active.messages.push({ type: "heartbeat" });
    } else if (message.method === "turn/completed") {
      const turn = requireRecord(params.turn);
      const turnId = requiredString(turn.id, "Codex App Server completed turn ID");
      if (active.turnId && turnId !== active.turnId) throw new Error("Codex App Server completed turn correlation mismatch");
      if (turn.status !== "completed") {
        active.result.reject(new Error(turnFailure(turn)));
      } else if (active.finalMessage === undefined) {
        active.result.reject(new Error("Codex App Server turn completed without a final agent message"));
      } else {
        active.result.resolve(parseStructuredMessage(active.finalMessage));
      }
      active.messages.close();
      thread.active = undefined;
      this.#scheduleIdleClose(thread);
    } else if (message.method === "error") {
      active.result.reject(new Error("Codex App Server reported a turn error"));
      active.messages.fail(new Error("Codex App Server reported a turn error"));
      thread.active = undefined;
    }
    return {};
  }

  async #serverRequest(thread: AppServerThread, message: JsonRpcInbound): Promise<unknown> {
    const active = thread.active;
    if (!active || typeof message.method !== "string") throw new Error("Codex App Server request has no active turn");
    const params = requireRecord(message.params ?? {});
    if (message.method === "mcpServer/elicitation/request" && !Object.hasOwn(params, "turnId")) {
      throw new Error("Codex App Server elicitation turn correlation is missing");
    }
    assertCorrelation(params, thread.threadId, active.turnId, true,
      message.method !== "mcpServer/elicitation/request", message.method === "mcpServer/elicitation/request");
    if (message.method === "item/tool/call") {
      const name = requiredString(params.tool, "Codex dynamic tool name");
      const tool = thread.tools.get(name);
      if (!tool) throw new Error("Codex requested an unknown dynamic tool");
      const output = validatePortableToolResult(await tool.invoke(params.arguments));
      return { contentItems: [{ type: "inputText", text: JSON.stringify(output) }], success: true };
    }
    const blocking = blockingRequest(message.method, params, message.id);
    if (!blocking) throw new Error("Codex App Server sent an unsupported server request");
    if (thread.config.operatorRequests === "reject") return rejectionFor(message.method);
    if (thread.config.operatorRequests === "auto" && automaticDecision(thread.config, message.method)) {
      return acceptanceFor(message.method);
    }
    active.messages.push(blocking);
    return new Promise(() => undefined);
  }

  #close(thread: AppServerThread, error: unknown): void {
    if (thread.closed) return;
    thread.closed = true;
    if (thread.idleTimer) clearTimeout(thread.idleTimer);
    thread.process.kill("SIGTERM");
    thread.connection.close(error);
    thread.active?.messages.fail(error);
    thread.active?.result.reject(error);
    thread.active = undefined;
  }

  #scheduleIdleClose(thread: AppServerThread): void {
    if (thread.closed || thread.active || thread.idleTimer) return;
    thread.idleTimer = setTimeout(() => {
      thread.idleTimer = undefined;
      if (!thread.active) this.#close(thread, new Error("Codex App Server idle thread closed"));
    }, 60_000);
    thread.idleTimer.unref?.();
  }
}

interface AppServerConfig {
  readonly operatorRequests: "auto" | "reject" | "block";
  readonly automaticApprovals: readonly ("command" | "file_change")[];
  readonly model?: string;
  readonly effort?: string;
  readonly approvalPolicy: "unlessTrusted" | "never";
  readonly sandbox: "readOnly" | "workspaceWrite" | "dangerFullAccess";
  readonly networkAccess: boolean;
}

function appServerConfig(value: Readonly<Record<string, unknown>>): AppServerConfig {
  const allowed = new Set(["operatorRequests", "automaticApprovals", "model", "effort", "approvalPolicy", "sandbox", "networkAccess", "maxTurns"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown Codex App Server runtime setting: ${key}`);
  const operatorRequests = value.operatorRequests ?? "reject";
  if (operatorRequests !== "auto" && operatorRequests !== "reject" && operatorRequests !== "block") throw new Error("Invalid Codex operatorRequests policy");
  const automaticApprovals = value.automaticApprovals ?? [];
  if (!Array.isArray(automaticApprovals) || automaticApprovals.some((item) => item !== "command" && item !== "file_change")) {
    throw new Error("Invalid Codex automaticApprovals policy");
  }
  if (operatorRequests !== "auto" && automaticApprovals.length) throw new Error("Codex automaticApprovals requires operatorRequests: auto");
  const model = optionalText(value.model, "Codex model");
  const effort = optionalText(value.effort, "Codex reasoning effort");
  const approvalPolicy = value.approvalPolicy ?? "unlessTrusted";
  if (approvalPolicy !== "unlessTrusted" && approvalPolicy !== "never") throw new Error("Invalid Codex approval policy");
  const sandbox = value.sandbox ?? "workspaceWrite";
  if (!["readOnly", "workspaceWrite", "dangerFullAccess"].includes(sandbox as string)) throw new Error("Invalid Codex sandbox policy");
  if (value.networkAccess !== undefined && typeof value.networkAccess !== "boolean") throw new Error("Invalid Codex network access policy");
  if (value.maxTurns !== undefined) positiveInteger(value.maxTurns, "Codex maxTurns");
  return Object.freeze({ operatorRequests, automaticApprovals: Object.freeze([...new Set(automaticApprovals)]),
    ...(model ? { model } : {}), ...(effort ? { effort } : {}), approvalPolicy: approvalPolicy as AppServerConfig["approvalPolicy"],
    sandbox: sandbox as AppServerConfig["sandbox"], networkAccess: value.networkAccess === true });
}

function threadStartParams(request: CodexRunRequest, config: AppServerConfig): Record<string, unknown> {
  return { ...(config.model ? { model: config.model } : {}), cwd: request.cwd,
    approvalPolicy: config.approvalPolicy, sandbox: config.sandbox, serviceName: "ensemble",
    ...(request.tools.length ? { dynamicTools: request.tools.map((tool) => ({ type: "function", name: tool.name,
      description: tool.description, inputSchema: tool.inputSchema })) } : {}) };
}

function turnStartParams(thread: AppServerThread, prompt: string): Record<string, unknown> {
  return { threadId: thread.threadId, input: [{ type: "text", text: prompt }], cwd: thread.cwd,
    approvalPolicy: thread.config.approvalPolicy,
    sandboxPolicy: thread.config.sandbox === "workspaceWrite"
      ? { type: "workspaceWrite", writableRoots: [thread.cwd], networkAccess: thread.config.networkAccess }
      : { type: thread.config.sandbox },
    ...(thread.config.model ? { model: thread.config.model } : {}),
    ...(thread.config.effort ? { effort: thread.config.effort } : {}),
    outputSchema: runtimeResultSchema };
}

const runtimeResultSchema = Object.freeze({ type: "object", properties: {
  outcome: { type: "string" }, summary: { type: "string" }, nextRole: { type: "string" },
  comments: { type: "array", items: { type: "string" } }, artifacts: { type: "array", items: { type: "object" } },
}, required: ["outcome", "summary", "comments", "artifacts"], additionalProperties: false });

interface JsonRpcInbound { readonly id?: string | number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: unknown }
type ServerRequestHandler = (message: JsonRpcInbound) => Promise<unknown>;

class JsonRpcConnection {
  readonly #process: CodexAppServerProcess;
  readonly #timeoutMs: number;
  readonly #handler: ServerRequestHandler;
  readonly #onClose: (error: unknown) => void;
  readonly #pending = new Map<number, Deferred<unknown>>();
  #nextId = 1;
  #closed = false;

  constructor(process: CodexAppServerProcess, timeoutMs: number, handler: ServerRequestHandler, onClose: (error: unknown) => void) {
    this.#process = process;
    this.#timeoutMs = timeoutMs;
    this.#handler = handler;
    this.#onClose = onClose;
    void this.#read();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Codex App Server connection is closed"));
    if (this.#pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Codex App Server request limit exceeded"));
    const id = this.#nextId++;
    const pending = deferred<unknown>();
    this.#pending.set(id, pending);
    try { this.#write({ method, id, params }); }
    catch (error) { this.#pending.delete(id); pending.reject(error); return pending.promise; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      pending.promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Codex App Server request timed out: ${method}`)), this.#timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); this.#pending.delete(id); });
  }

  notify(method: string, params: unknown): void { this.#write({ method, params }); }

  close(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#onClose(error);
  }

  async #read(): Promise<void> {
    try {
      for await (const line of jsonLines(this.#process.stdout)) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error("Codex App Server emitted malformed JSONL"); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex App Server emitted an invalid message");
        const message = value as JsonRpcInbound;
        if (message.id !== undefined && message.method === undefined) {
          const id = typeof message.id === "number" ? message.id : Number.NaN;
          const pending = this.#pending.get(id);
          if (!pending) throw new Error("Codex App Server response has unknown request ID");
          if (message.error !== undefined) pending.reject(protocolError(message.error));
          else pending.resolve(message.result);
        } else if (message.method) {
          if (message.id === undefined) await this.#handler(message);
          else void this.#handler(message).then(
            (result) => this.#write({ id: message.id, result }),
            () => this.#write({ id: message.id, error: { code: -32_000, message: "Ensemble rejected the request" } }),
          ).catch((error: unknown) => this.close(error));
        } else throw new Error("Codex App Server emitted an invalid protocol message");
      }
      throw new Error("Codex App Server output ended");
    } catch (error) { this.close(error); }
  }

  #write(value: unknown): void {
    if (this.#closed) throw new Error("Codex App Server connection is closed");
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Codex App Server outbound message exceeds maximum size");
    if (!this.#process.stdin.write(line)) throw new Error("Codex App Server write backpressure limit reached");
  }
}

async function* jsonLines(source: AsyncIterable<Uint8Array | string>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Codex App Server inbound message exceeds maximum size");
      yield line;
      buffer = buffer.slice(index + 1);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) throw new Error("Codex App Server inbound message exceeds maximum size");
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

function blockingRequest(method: string, params: Record<string, unknown>, rpcId: string | number | undefined): unknown {
  const at = new Date().toISOString();
  const requestId = params.requestId ?? params.itemId ?? (rpcId === undefined ? undefined : `jsonrpc:${String(rpcId)}`);
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval") {
    return { type: "approval_requested", at, request: { kind: "approval", summary: approvalSummary(method, params),
      ...(typeof requestId === "string" ? { requestId } : {}), createdAt: at } };
  }
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    return { type: "user_input_requested", at, request: { kind: "user_input", summary: "Codex requires user input",
      ...(typeof requestId === "string" ? { requestId } : {}), createdAt: at } };
  }
  if (method === "mcpServer/elicitation/request") {
    return { type: "tool_elicitation_requested", at, request: { kind: "tool_elicitation",
      summary: typeof params.message === "string" ? boundedUtf8(params.message, 2_048) : "An MCP server requires operator input",
      ...(typeof requestId === "string" ? { requestId } : {}), createdAt: at } };
  }
  return undefined;
}

function approvalSummary(method: string, params: Record<string, unknown>): string {
  const reason = typeof params.reason === "string" ? boundedUtf8(params.reason, 1_900) : undefined;
  const subject = method.includes("commandExecution") ? "command execution" : method.includes("fileChange") ? "file changes" : "additional permissions";
  return reason ? `Codex requests approval for ${subject}: ${reason}` : `Codex requests approval for ${subject}`;
}

function rejectionFor(method: string): unknown {
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null };
  if (method.includes("requestUserInput")) return { answers: {} };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  return { decision: "decline" };
}

function acceptanceFor(method: string): unknown {
  return method.includes("requestApproval") ? { decision: "accept" } : rejectionFor(method);
}

function automaticDecision(config: AppServerConfig, method: string): boolean {
  return (method === "item/commandExecution/requestApproval" && config.automaticApprovals.includes("command"))
    || (method === "item/fileChange/requestApproval" && config.automaticApprovals.includes("file_change"));
}

function itemEvent(method: string, item: Record<string, unknown>): unknown {
  const started = method === "item/started";
  if (item.type === "commandExecution") {
    const tool = typeof item.command === "string" ? boundedUtf8(item.command, 256) : "command";
    return started ? { type: "tool_started", tool } : { type: "tool_finished", tool, success: item.status === "completed" };
  }
  if (item.type === "fileChange") return started ? { type: "tool_started", tool: "file_change" }
    : { type: "tool_finished", tool: "file_change", success: item.status === "completed" };
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") return started
    ? { type: "tool_started", tool: boundedUtf8(item.tool, 256) }
    : { type: "tool_finished", tool: boundedUtf8(item.tool, 256), success: item.success === true };
  return undefined;
}

function usageEvent(params: Record<string, unknown>): unknown {
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
  const total = tokenUsage && isRecord(tokenUsage.total) ? tokenUsage.total : undefined;
  if (!total) return undefined;
  const input = numberFrom(total, ["inputTokens"]);
  const output = numberFrom(total, ["outputTokens"]);
  const all = numberFrom(total, ["totalTokens"]);
  if (input === undefined || output === undefined || all === undefined) return undefined;
  return { type: "usage_updated", inputTokens: input, outputTokens: output, totalTokens: all };
}

function rateLimitEvents(params: Record<string, unknown>): readonly unknown[] {
  const snapshot = isRecord(params.rateLimits) ? params.rateLimits : undefined;
  if (!snapshot) return [];
  const limitId = typeof snapshot.limitId === "string" && snapshot.limitId ? snapshot.limitId : "default";
  return (["primary", "secondary"] as const).flatMap((windowName) => {
    const window = isRecord(snapshot[windowName]) ? snapshot[windowName] : undefined;
    if (!window || typeof window.usedPercent !== "number") return [];
    const resetsAt = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
      ? new Date(window.resetsAt * 1_000).toISOString() : undefined;
    return [{ type: "rate_limit_updated", limitId: `${limitId}:${windowName}`, usedPercent: window.usedPercent,
      ...(resetsAt ? { resetsAt } : {}) }];
  });
}

function assertCorrelation(
  params: Record<string, unknown>, threadId: string, turnId: string | undefined,
  requireThread: boolean, requireTurn: boolean, allowNullTurn = false,
): void {
  if ((requireThread && params.threadId === undefined) || (params.threadId !== undefined && params.threadId !== threadId)) {
    throw new Error("Codex App Server thread correlation mismatch");
  }
  const suppliedTurn = allowNullTurn && params.turnId === null ? undefined : params.turnId;
  if ((requireTurn && suppliedTurn === undefined) || (turnId !== undefined && suppliedTurn !== undefined && suppliedTurn !== turnId)) {
    throw new Error("Codex App Server turn correlation mismatch");
  }
}

function isActivityDelta(method: string): boolean {
  return method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta"
    || method === "item/reasoning/textDelta" || method === "item/commandExecution/outputDelta"
    || method === "item/fileChange/outputDelta";
}

function turnFailure(turn: Record<string, unknown>): string {
  if (isRecord(turn.error) && typeof turn.error.message === "string") return `Codex turn failed: ${boundedUtf8(turn.error.message, 2_048)}`;
  return `Codex turn ended with status ${String(turn.status)}`;
}

function protocolError(value: unknown): Error {
  if (isRecord(value) && typeof value.code === "number" && typeof value.message === "string") {
    return new Error(`Codex App Server error ${value.code}: ${boundedUtf8(value.message, 2_048)}`);
  }
  return new Error("Codex App Server returned an invalid protocol error");
}

function parseStructuredMessage(message: string): unknown {
  const trimmed = message.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  try { return JSON.parse(fenced?.[1] ?? trimmed); }
  catch { throw new Error("Codex final message is not valid structured JSON"); }
}

class MessageQueue implements AsyncIterable<unknown> {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<Deferred<IteratorResult<unknown>>> = [];
  #closed = false;
  #error: unknown;
  push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else {
      if (this.#values.length >= MAX_BUFFERED_MESSAGES) throw new Error("Codex App Server event buffer limit exceeded");
      this.#values.push(value);
    }
  }
  close(): void { this.#closed = true; while (this.#waiters.length) this.#waiters.shift()!.resolve({ done: true, value: undefined }); }
  fail(error: unknown): void { this.#values.length = 0; this.#error = error; while (this.#waiters.length) this.#waiters.shift()!.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<unknown> { return { next: async () => {
    if (this.#values.length) return { done: false, value: this.#values.shift() } as IteratorResult<unknown>;
    if (this.#error !== undefined) throw this.#error;
    if (this.#closed) return { done: true, value: undefined };
    const waiter = deferred<IteratorResult<unknown>>(); this.#waiters.push(waiter); return waiter.promise;
  } }; }
}

interface Deferred<T> { readonly promise: Promise<T>; readonly settled: boolean; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void; let rejectPromise!: (error: unknown) => void; let settled = false;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, get settled() { return settled; }, resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error) { if (!settled) { settled = true; rejectPromise(error); } } };
}

function requireRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error("Codex App Server protocol record is invalid"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function nestedString(value: Record<string, unknown>, key: string, child: string): string { return requiredString(requireRecord(value[key])[child], `Codex App Server ${key} ${child}`); }
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 256) throw new Error(`${label} is invalid`); return value; }
function optionalText(value: unknown, label: string): string | undefined { if (value === undefined) return undefined; return requiredString(value, label); }
function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`); return value as number; }
export function boundedUtf8(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("UTF-8 byte limit must be a nonnegative safe integer");
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const appendMarker = maximumBytes >= markerBytes;
  const contentBytes = maximumBytes - (appendMarker ? markerBytes : 0);
  let output = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > contentBytes) break;
    output += character;
    usedBytes += characterBytes;
  }
  return appendMarker ? `${output}${marker}` : output;
}
function numberFrom(value: Record<string, unknown>, keys: readonly string[]): number | undefined { for (const key of keys) if (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) return value[key] as number; return undefined; }
