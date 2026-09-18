import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeTool } from "../../domain/model.ts";
import { ProcessTerminationUnconfirmedError } from "../../execution/process.ts";
import { startOpenCodeToolBridge } from "./tool-bridge.ts";
import type { OpenCodeRunRequest, OpenCodeTransport, OpenCodeTransportSession } from "./runtime.ts";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_BUFFERED_MESSAGES = 4_096;
const PROCESS_STOP_GRACE_MS = 1_000;
const MAX_STARTUP_OUTPUT_BYTES = 8_192;

const controlledEnvironment = Object.freeze({
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled" }),
  OPENCODE_PERMISSION: JSON.stringify({ external_directory: "deny" }),
});

export interface OpenCodeServerProcess {
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly ready: Promise<string>;
  isRunning(): boolean;
  kill(signal?: NodeJS.Signals): void;
}

export interface OpenCodeServerLauncher {
  launch(executable: string, arguments_: readonly string[], options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }): OpenCodeServerProcess;
}

export class NodeOpenCodeServerLauncher implements OpenCodeServerLauncher {
  launch(executable: string, arguments_: readonly string[], options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }): OpenCodeServerProcess {
    if (process.platform === "win32") throw new Error("OpenCode runtime requires POSIX process-group isolation");
    const ownsProcessGroup = true;
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: { ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
    child.stderr.resume();
    let startupOutput = "";
    let resolveReady!: (baseUrl: string) => void;
    let rejectReady!: (error: unknown) => void;
    let readySettled = false;
    const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (readySettled) return;
      startupOutput += String(chunk);
      if (Buffer.byteLength(startupOutput, "utf8") > MAX_STARTUP_OUTPUT_BYTES) {
        readySettled = true;
        rejectReady(new Error("OpenCode server startup output exceeded its limit"));
        return;
      }
      const match = startupOutput.match(/https?:\/\/127\.0\.0\.1:\d+/u);
      if (match) {
        readySettled = true;
        resolveReady(match[0]);
      }
    });
    child.stdout.resume();
    const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", (error) => {
        if (!readySettled) { readySettled = true; rejectReady(error); }
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error("OpenCode server exited before confirming listener ownership"));
        }
        if (code === 0 || signal === "SIGTERM") resolve({ code, signal });
        else reject(new Error(`OpenCode server failed (${signal ?? code ?? "unknown"})`));
      });
    });
    return { exit, ready, isRunning: () => {
      if (!ownsProcessGroup || child.pid === undefined) return child.exitCode === null && child.signalCode === null;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        throw error;
      }
    }, kill: (signal = "SIGTERM") => {
      if (!ownsProcessGroup || child.pid === undefined) {
        child.kill(signal);
        return;
      }
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } };
  }
}

export interface OpenCodeServerTransportOptions {
  readonly executable?: string;
  readonly launcher?: OpenCodeServerLauncher;
  readonly environment?: Readonly<Record<string, string>>;
  readonly serverArguments?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly processStopTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

interface OpenCodeConfig {
  readonly operatorRequests: "auto" | "reject" | "block";
  readonly automaticApprovals: readonly string[];
  readonly model?: { readonly providerID: string; readonly modelID: string };
}

interface ActiveTurn {
  readonly messages: MessageQueue;
  readonly result: Deferred<unknown>;
  readonly idle: Deferred<void>;
}

interface ServerState {
  readonly process: OpenCodeServerProcess;
  readonly baseUrl: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly config: OpenCodeConfig;
  readonly authorization: string;
  readonly configDirectory: string;
  readonly eventsAbort: AbortController;
  readonly bridge?: Awaited<ReturnType<typeof startOpenCodeToolBridge>>;
  active?: ActiveTurn;
  closing?: Promise<void>;
  closed: boolean;
}

export class OpenCodeServerTransport implements OpenCodeTransport {
  readonly executable: string;
  readonly launcher: OpenCodeServerLauncher;
  readonly environment: Readonly<Record<string, string>>;
  readonly serverArguments: readonly string[];
  readonly requestTimeoutMs: number;
  readonly processStopTimeoutMs: number;
  readonly #sessions = new WeakMap<OpenCodeTransportSession, ServerState>();

  constructor(options: OpenCodeServerTransportOptions = {}) {
    if ((options.platform ?? process.platform) === "win32") {
      throw new Error("OpenCode runtime is unsupported on Windows because process-tree termination cannot be guaranteed");
    }
    this.executable = options.executable ?? "opencode";
    this.launcher = options.launcher ?? new NodeOpenCodeServerLauncher();
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    this.serverArguments = Object.freeze([...(options.serverArguments ?? ["serve", "--pure"])]);
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 30_000, "OpenCode server request timeout");
    this.processStopTimeoutMs = positiveInteger(options.processStopTimeoutMs ?? PROCESS_STOP_GRACE_MS, "OpenCode process stop timeout");
  }

  validateConfiguration(config: Readonly<Record<string, unknown>>): void { openCodeConfig(config); }

  async diagnose(cwd: string): Promise<void> {
    const state = await this.#launch(cwd, openCodeConfig({}), [], false);
    await this.#close(state, false);
  }

  async start(request: OpenCodeRunRequest): Promise<OpenCodeTransportSession> {
    const config = openCodeConfig(request.config);
    const state = await this.#launch(request.cwd, config, request.tools);
    try { return this.#startTurn(state, request.prompt); }
    catch (error) { await this.#close(state, true); throw error; }
  }

  async resume(session: OpenCodeTransportSession, prompt: string): Promise<OpenCodeTransportSession> {
    const state = this.#sessions.get(session);
    if (!state || state.closed) throw new Error("Cannot resume an unknown or closed OpenCode session");
    if (state.active) throw new Error("Cannot resume an active OpenCode turn");
    return this.#startTurn(state, prompt);
  }

  async cancel(session: OpenCodeTransportSession): Promise<void> {
    const state = this.#sessions.get(session);
    if (!state) return;
    if (state.closing) return state.closing;
    if (state.closed) return;
    await this.#close(state, true);
  }

  async #launch(cwd: string, config: OpenCodeConfig, tools: readonly RuntimeTool[], createSession = true): Promise<ServerState> {
    const port = await availablePort();
    const configDirectory = await mkdtemp(join(tmpdir(), "ensemble-opencode-"));
    const password = randomBytes(32).toString("base64url");
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const arguments_ = [...this.serverArguments, "--hostname", "127.0.0.1", "--port", String(port)];
    let process: OpenCodeServerProcess;
    try {
      const dataHome = this.environment.XDG_DATA_HOME
        ?? (this.environment.HOME ? join(this.environment.HOME, ".local", "share") : undefined);
      process = this.launcher.launch(this.executable, arguments_, {
        cwd,
        environment: {
          ...this.environment,
          ...controlledEnvironment,
          HOME: configDirectory,
          XDG_CONFIG_HOME: configDirectory,
          ...(dataHome ? { XDG_DATA_HOME: dataHome } : {}),
          OPENCODE_SERVER_PASSWORD: password,
        },
      });
    } catch (error) {
      await removeConfigDirectory(configDirectory);
      throw error;
    }
    void process.exit.catch(() => undefined);
    const startupExit = process.exit.then<never>(
      () => { throw new Error("OpenCode server exited during startup"); },
      () => { throw new Error("OpenCode server failed during startup"); },
    );
    void startupExit.catch(() => undefined);
    const baseUrl = `http://127.0.0.1:${port}`;
    let bridge: Awaited<ReturnType<typeof startOpenCodeToolBridge>> | undefined;
    try {
      const confirmedBaseUrl = await raceStartup(listenerWithin(process.ready, this.requestTimeoutMs), startupExit);
      if (confirmedBaseUrl !== baseUrl) throw new Error("OpenCode confirmed an unexpected listener endpoint");
      await waitForHealth(baseUrl, authorization, this.requestTimeoutMs, process.exit);
      await new Promise<void>((resolve) => setImmediate(resolve));
      ensureRunning(process);
      if (tools.length) bridge = await startOpenCodeToolBridge(tools);
      if (bridge) {
        const statuses = await raceStartup(requestJson(baseUrl, "/mcp", this.requestTimeoutMs, {
          method: "POST",
          body: { name: bridge.name, config: { type: "remote", url: bridge.url, enabled: true, oauth: false, timeout: this.requestTimeoutMs } },
          authorization,
        }), startupExit);
        const bridgeStatus = isRecord(statuses) ? statuses[bridge.name] : undefined;
        if (!isRecord(bridgeStatus) || bridgeStatus.status !== "connected") {
          throw new Error("OpenCode did not connect the Ensemble tool bridge");
        }
      }
      const created = createSession
        ? await raceStartup(requestJson(baseUrl, "/session", this.requestTimeoutMs, { method: "POST", body: {}, authorization }), startupExit)
        : undefined;
      ensureRunning(process);
      const sessionId = createSession ? requiredString(isRecord(created) ? created.id : undefined, "OpenCode session ID") : "diagnostic";
      const state: ServerState = { process, baseUrl, cwd, sessionId, config, authorization, configDirectory, eventsAbort: new AbortController(),
        ...(bridge ? { bridge } : {}), closed: false };
      if (createSession) await this.#connectEvents(state);
      void process.exit.then(
        () => this.#fail(state, new Error("OpenCode server exited")),
        (error: unknown) => this.#fail(state, error),
      );
      return state;
    } catch (error) {
      await bridge?.close().catch(() => undefined);
      await stopProcess(process, this.processStopTimeoutMs);
      await removeConfigDirectory(configDirectory);
      throw error;
    }
  }

  #startTurn(state: ServerState, prompt: string): OpenCodeTransportSession {
    if (state.active) throw new Error("OpenCode session already has an active turn");
    const active: ActiveTurn = { messages: new MessageQueue(), result: deferred<unknown>(), idle: deferred<void>() };
    void active.result.promise.catch(() => undefined);
    state.active = active;
    state.bridge?.activate();
    const session = Object.freeze({ id: state.sessionId, messages: active.messages, result: active.result.promise });
    this.#sessions.set(session, state);
    void this.#prompt(state, prompt, active);
    return session;
  }

  async #prompt(state: ServerState, prompt: string, active: ActiveTurn): Promise<void> {
    try {
      const response = await requestJson(state.baseUrl, `/session/${encodeURIComponent(state.sessionId)}/message`, undefined, {
        method: "POST",
        directory: state.cwd,
        authorization: state.authorization,
        signal: state.eventsAbort.signal,
        body: {
          ...(state.config.model ? { model: state.config.model } : {}),
          format: { type: "json_schema", schema: runtimeResultSchema, retryCount: 2 },
          parts: [{ type: "text", text: prompt }],
        },
      });
      const info = isRecord(response) && isRecord(response.info) ? response.info : undefined;
      if (!info) throw new Error("OpenCode returned an invalid assistant response");
      if (info.error !== undefined) throw new Error(`OpenCode request failed; verify authentication with 'opencode auth login': ${errorName(info.error)}`);
      if (info.structured === undefined) throw new Error("OpenCode returned no structured output");
      await Promise.race([active.idle.promise, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
      state.bridge?.deactivate();
      if (state.active === active) state.active = undefined;
      await this.#close(state, false);
      active.result.resolve(info.structured);
      active.messages.close();
    } catch (error) {
      active.result.reject(error);
      active.messages.fail(error);
      state.active = undefined;
      await this.#close(state, false).catch(() => undefined);
    }
  }

  async #connectEvents(state: ServerState): Promise<void> {
    const startupAbort = new AbortController();
    const timer = setTimeout(() => startupAbort.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${state.baseUrl}/event`, {
        headers: { accept: "text/event-stream", authorization: state.authorization, "x-opencode-directory": state.cwd },
        signal: AbortSignal.any([state.eventsAbort.signal, startupAbort.signal]),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed with HTTP ${response.status}`);
    void this.#readEvents(state, response.body).catch((error: unknown) => this.#fail(state, error));
  }

  async #readEvents(state: ServerState, body: ReadableStream<Uint8Array>): Promise<void> {
    for await (const data of sseData(body)) {
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new Error("OpenCode event stream emitted malformed JSON"); }
      await this.#handleEvent(state, event);
    }
    if (!state.closed) throw new Error("OpenCode event stream ended unexpectedly");
  }

  async #handleEvent(state: ServerState, value: unknown): Promise<void> {
    if (!state.active || !isRecord(value) || typeof value.type !== "string" || !isRecord(value.properties)) return;
    const properties = value.properties;
    if (!matchesSession(properties, state.sessionId)) return;
    if (value.type === "session.idle") {
      state.active.idle.resolve();
      return;
    }
    if (value.type === "session.status" && isRecord(properties.status) && properties.status.type === "retry") {
      state.active.messages.push({ type: "progress_updated", message: "OpenCode is retrying after a transient provider error" });
      return;
    }
    if (value.type === "session.error") {
      this.#fail(state, new Error("OpenCode session reported an error"));
      return;
    }
    if (value.type === "message.part.delta") {
      state.active.messages.push({ type: "heartbeat" });
      return;
    }
    if (value.type === "message.part.updated" && isRecord(properties.part) && properties.part.type === "tool") {
      const part = properties.part;
      const tool = typeof part.tool === "string" ? bounded(part.tool, 256) : "tool";
      const status = isRecord(part.state) ? part.state.status : undefined;
      if (status === "running") state.active.messages.push({ type: "tool_started", tool });
      else if (status === "completed" || status === "error") {
        state.active.messages.push({ type: "tool_finished", tool, success: status === "completed" });
      }
      return;
    }
    if (value.type === "message.updated" && isRecord(properties.info) && properties.info.role === "assistant") {
      const tokens = isRecord(properties.info.tokens) ? properties.info.tokens : undefined;
      const input = integer(tokens?.input);
      const output = integer(tokens?.output);
      if (input !== undefined && output !== undefined) {
        state.active.messages.push({ type: "usage_updated", inputTokens: input, outputTokens: output, totalTokens: input + output });
      }
      return;
    }
    if (value.type === "permission.asked" || value.type === "permission.v2.asked") {
      await this.#permission(state, properties);
      return;
    }
    if (value.type === "question.asked" || value.type === "question.v2.asked") await this.#question(state, properties);
  }

  async #permission(state: ServerState, properties: Record<string, unknown>): Promise<void> {
    const requestId = requiredString(properties.id ?? properties.requestID, "OpenCode permission request ID");
    const permission = typeof properties.permission === "string" ? properties.permission : "additional access";
    if (state.config.operatorRequests === "block") {
      const at = new Date().toISOString();
      state.active?.messages.push({ type: "approval_requested", at,
        request: { kind: "approval", summary: `OpenCode requests permission: ${bounded(permission, 1_900)}`, requestId, createdAt: at } });
      state.bridge?.deactivate();
      return;
    }
    const approved = state.config.operatorRequests === "auto" && state.config.automaticApprovals.includes(permission);
    await this.#request(state, `/permission/${encodeURIComponent(requestId)}/reply`, {
      method: "POST", body: { reply: approved ? "once" : "reject" },
    });
  }

  async #question(state: ServerState, properties: Record<string, unknown>): Promise<void> {
    const requestId = requiredString(properties.id ?? properties.requestID, "OpenCode question request ID");
    if (state.config.operatorRequests === "block") {
      const at = new Date().toISOString();
      state.active?.messages.push({ type: "user_input_requested", at,
        request: { kind: "user_input", summary: questionSummary(properties), requestId, createdAt: at } });
      state.bridge?.deactivate();
      return;
    }
    await this.#request(state, `/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
  }

  #request(state: ServerState, path: string, options: RequestOptions): Promise<unknown> {
    return requestJson(state.baseUrl, path, this.requestTimeoutMs, {
      ...options,
      directory: state.cwd,
      authorization: state.authorization,
      signal: state.eventsAbort.signal,
    });
  }

  #fail(state: ServerState, error: unknown): void {
    if (state.closed) return;
    state.active?.messages.fail(error);
    state.active?.result.reject(error);
    state.active = undefined;
    void this.#close(state, false).catch(() => undefined);
  }

  async #close(state: ServerState, cancelled: boolean): Promise<void> {
    if (state.closing) return state.closing;
    state.closed = true;
    state.closing = this.#finishClose(state, cancelled);
    return state.closing;
  }

  async #finishClose(state: ServerState, cancelled: boolean): Promise<void> {
    state.bridge?.deactivate();
    const abortRequest = cancelled
      ? requestJson(state.baseUrl, `/session/${encodeURIComponent(state.sessionId)}/abort`, Math.min(this.requestTimeoutMs, 250), {
        method: "POST", directory: state.cwd, authorization: state.authorization,
      }).catch(() => undefined)
      : Promise.resolve();
    state.eventsAbort.abort();
    const error = new Error(cancelled ? "OpenCode session cancelled" : "OpenCode session closed");
    state.active?.messages.fail(error);
    state.active?.result.reject(error);
    state.active = undefined;
    await abortRequest;
    await state.bridge?.close().catch(() => undefined);
    await stopProcess(state.process, this.processStopTimeoutMs);
    await removeConfigDirectory(state.configDirectory);
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly directory?: string;
  readonly authorization?: string;
  readonly signal?: AbortSignal;
}

async function requestJson(baseUrl: string, path: string, timeoutMs: number | undefined, options: RequestOptions = {}): Promise<unknown> {
  const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signal = timeoutSignal && options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal ?? options.signal;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.directory ? { "x-opencode-directory": options.directory } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(signal ? { signal } : {}),
  });
  const text = await boundedResponse(response);
  if (!response.ok) throw new Error(`OpenCode request failed with HTTP ${response.status}`);
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { throw new Error("OpenCode returned malformed JSON"); }
}

async function boundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("OpenCode response exceeds maximum size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OpenCode response exceeds maximum size");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function waitForHealth(baseUrl: string, authorization: string, timeoutMs: number, exit: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson(baseUrl, "/global/health", Math.min(1_000, Math.max(1, deadline - Date.now())), { authorization });
      if (isRecord(health) && health.healthy === true && typeof health.version === "string") return;
      lastError = new Error("OpenCode returned an invalid health response");
    } catch (error) { lastError = error; }
    const exited = await Promise.race([exit.then(() => true, () => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))]);
    if (exited) throw new Error("OpenCode server exited during startup", { cause: lastError });
  }
  throw new Error("OpenCode server health check timed out", { cause: lastError });
}

async function stopProcess(process: OpenCodeServerProcess, timeoutMs: number): Promise<void> {
  if (!process.isRunning()) return;
  process.kill("SIGTERM");
  if (await waitUntilStopped(process, timeoutMs)) return;
  process.kill("SIGKILL");
  if (!await waitUntilStopped(process, timeoutMs)) {
    throw new ProcessTerminationUnconfirmedError("OpenCode process group");
  }
}

async function removeConfigDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function waitUntilStopped(process: OpenCodeServerProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (process.isRunning() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return !process.isRunning();
}

async function listenerWithin(ready: Promise<string>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode listener ownership confirmation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function raceStartup<T>(work: Promise<T>, exit: Promise<never>): Promise<T> {
  return Promise.race([work, exit]);
}

function ensureRunning(process: OpenCodeServerProcess): void {
  if (!process.isRunning()) throw new Error("OpenCode server exited during startup");
}

function questionSummary(properties: Record<string, unknown>): string {
  const questions = Array.isArray(properties.questions) ? properties.questions : [];
  const text = questions.map((question) => {
    if (!isRecord(question)) return "";
    const prompt = typeof question.question === "string" ? question.question : typeof question.header === "string" ? question.header : "";
    const options = Array.isArray(question.options) ? question.options.map((option) => {
      if (typeof option === "string") return option;
      return isRecord(option) && typeof option.label === "string" ? option.label : "";
    }).filter(Boolean).slice(0, 10) : [];
    return options.length ? `${prompt} Options: ${options.join(", ")}` : prompt;
  }).filter(Boolean).join("; ");
  return bounded(text ? `OpenCode requires user input: ${text}` : "OpenCode requires user input", 1_900);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate an OpenCode server port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function* sseData(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) throw new Error("OpenCode event exceeds maximum size");
    for (;;) {
      const boundary = buffer.search(/\r?\n\r?\n/u);
      if (boundary < 0) break;
      const separator = buffer.slice(boundary).startsWith("\r\n\r\n") ? 4 : 2;
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + separator);
      const data = record.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
  }
}

function openCodeConfig(value: Readonly<Record<string, unknown>>): OpenCodeConfig {
  const allowed = new Set(["operatorRequests", "automaticApprovals", "model"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown OpenCode runtime setting: ${key}`);
  const operatorRequests = value.operatorRequests ?? "reject";
  if (operatorRequests !== "auto" && operatorRequests !== "reject" && operatorRequests !== "block") {
    throw new Error("Invalid OpenCode operatorRequests policy");
  }
  const automaticApprovals = value.automaticApprovals ?? [];
  if (!Array.isArray(automaticApprovals) || automaticApprovals.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Invalid OpenCode automaticApprovals policy");
  }
  if (operatorRequests !== "auto" && automaticApprovals.length) throw new Error("OpenCode automaticApprovals requires operatorRequests: auto");
  let model: OpenCodeConfig["model"];
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(value.model)) {
      throw new Error("OpenCode model must use provider/model format");
    }
    const separator = value.model.indexOf("/");
    model = { providerID: value.model.slice(0, separator), modelID: value.model.slice(separator + 1) };
  }
  return Object.freeze({ operatorRequests, automaticApprovals: Object.freeze([...new Set(automaticApprovals as string[])]), ...(model ? { model } : {}) });
}

const runtimeResultSchema = Object.freeze({ type: "object", properties: {
  outcome: { type: "string" }, summary: { type: "string" }, nextRole: { type: ["string", "null"] },
  comments: { type: "array", items: { type: "string" } }, artifacts: { type: "array", items: {
    type: "object", properties: { type: { type: "string" }, url: { type: "string" }, name: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] } }, required: ["type", "url"], additionalProperties: false,
  } },
}, required: ["outcome", "summary", "comments", "artifacts"], additionalProperties: false });

function matchesSession(properties: Record<string, unknown>, sessionId: string): boolean {
  if (properties.sessionID === sessionId) return true;
  if (isRecord(properties.part) && properties.part.sessionID === sessionId) return true;
  if (isRecord(properties.info) && properties.info.sessionID === sessionId) return true;
  return false;
}

function errorName(value: unknown): string {
  if (isRecord(value) && typeof value.name === "string") return bounded(value.name, 128);
  return "provider error";
}

function integer(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; }
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 256) throw new Error(`${label} is invalid`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}
function bounded(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}`, "utf8") > bytes) break;
    output += character;
  }
  return output;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

class MessageQueue implements AsyncIterable<unknown> {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<Deferred<IteratorResult<unknown>>> = [];
  #closed = false;
  #error: unknown;
  push(value: unknown): void {
    if (this.#closed || this.#error !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else {
      if (this.#values.length >= MAX_BUFFERED_MESSAGES) throw new Error("OpenCode event buffer limit exceeded");
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

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error) { if (!settled) { settled = true; rejectPromise(error); } } };
}
