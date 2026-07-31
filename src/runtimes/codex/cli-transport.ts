import { spawn } from "node:child_process";
import type { CodexRunRequest, CodexTransport, CodexTransportSession } from "./runtime.ts";

export interface CodexProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface CodexProcessLauncher {
  launch(executable: string, arguments_: readonly string[], options: { readonly cwd: string }): CodexProcess;
}

export class NodeCodexProcessLauncher implements CodexProcessLauncher {
  launch(executable: string, arguments_: readonly string[], options: { readonly cwd: string }): CodexProcess {
    const child = spawn(executable, [...arguments_], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve({ code, signal });
        else reject(new Error(`Codex CLI failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
      });
    });
    return {
      stdout: child.stdout,
      exit,
      kill: (signal = "SIGTERM") => { child.kill(signal); },
    };
  }
}

export interface CodexCliTransportOptions {
  readonly executable?: string;
  readonly launcher?: CodexProcessLauncher;
  /** Arguments placed after `codex exec` and before the prompt. */
  readonly executionArguments?: readonly string[];
}

/** Process-backed transport for the documented `codex exec --json` protocol. */
export class CodexCliTransport implements CodexTransport {
  readonly executable: string;
  readonly launcher: CodexProcessLauncher;
  readonly executionArguments: readonly string[];
  readonly #processes = new WeakMap<CodexTransportSession, CodexProcess>();

  constructor(options: CodexCliTransportOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.launcher = options.launcher ?? new NodeCodexProcessLauncher();
    this.executionArguments = options.executionArguments ?? ["--sandbox", "workspace-write", "--skip-git-repo-check"];
  }

  start(request: CodexRunRequest): Promise<CodexTransportSession> {
    const runtimeArguments = codexRuntimeArguments(request.config);
    return this.#launch(
      ["exec", "--json", ...this.executionArguments, ...runtimeArguments, request.prompt],
      request.cwd,
    );
  }

  resume(session: CodexTransportSession, prompt: string): Promise<CodexTransportSession> {
    const process = this.#processes.get(session);
    if (process) throw new Error(`Cannot resume active Codex session: ${session.id}`);
    return this.#launch(["exec", "resume", "--json", session.id, prompt], processCwd(session));
  }

  async cancel(session: CodexTransportSession): Promise<void> {
    const process = this.#processes.get(session);
    if (!process) return;
    process.kill("SIGTERM");
    await process.exit.catch(() => undefined);
    this.#processes.delete(session);
  }

  async #launch(arguments_: readonly string[], cwd: string): Promise<CodexTransportSession> {
    const process = this.launcher.launch(this.executable, arguments_, { cwd });
    const messages = new AsyncMessageQueue();
    const thread = deferred<string>();
    const result = deferred<unknown>();
    void result.promise.catch(() => undefined);
    void consumeCodexOutput(process, messages, thread, result);
    const id = await thread.promise;
    const session = Object.freeze({ id, messages, result: result.promise, cwd }) as CodexTransportSession & { readonly cwd: string };
    this.#processes.set(session, process);
    void process.exit.finally(() => { this.#processes.delete(session); }).catch(() => undefined);
    return session;
  }
}

function codexRuntimeArguments(config: Readonly<Record<string, unknown>>): readonly string[] {
  const model = config.model;
  if (model === undefined) return [];
  if (typeof model !== "string" || model.trim().length === 0) throw new Error("Codex runtime config model must be a non-empty string");
  return ["--model", model];
}

async function consumeCodexOutput(
  process: CodexProcess,
  messages: AsyncMessageQueue,
  thread: Deferred<string>,
  result: Deferred<unknown>,
): Promise<void> {
  let finalMessage: string | undefined;
  try {
    for await (const line of lines(process.stdout)) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); }
      catch (error) { throw new Error(`Codex CLI emitted malformed JSONL: ${line}`, { cause: error }); }
      if (isRecord(record) && record.type === "thread.started" && typeof record.thread_id === "string") thread.resolve(record.thread_id);
      if (isAgentMessage(record)) finalMessage = record.item.text;
      if (isRecord(record) && (record.type === "turn.failed" || record.type === "error")) {
        throw new Error(codexErrorMessage(record));
      }
      const normalized = normalizeCodexRecord(record);
      if (normalized) messages.push(normalized);
    }
    await process.exit;
    if (!thread.settled) throw new Error("Codex CLI ended without a thread.started record");
    if (finalMessage === undefined) throw new Error("Codex CLI ended without a final agent message");
    result.resolve(parseStructuredMessage(finalMessage));
    messages.close();
  } catch (error) {
    thread.reject(error);
    result.reject(error);
    messages.fail(error);
  }
}

async function* lines(source: AsyncIterable<Uint8Array | string>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

class AsyncMessageQueue implements AsyncIterable<unknown> {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<Deferred<IteratorResult<unknown>>> = [];
  #closed = false;
  #error: unknown;

  push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }
  close(): void {
    this.#closed = true;
    while (this.#waiters.length) this.#waiters.shift()!.resolve({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    this.#error = error;
    while (this.#waiters.length) this.#waiters.shift()!.reject(error);
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        if (this.#values.length) return { done: false, value: this.#values.shift() } as IteratorResult<unknown>;
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { done: true, value: undefined };
        const waiter = deferred<IteratorResult<unknown>>();
        this.#waiters.push(waiter);
        return waiter.promise;
      },
    };
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {
    promise,
    get settled() { return settled; },
    resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error) { if (!settled) { settled = true; rejectPromise(error); } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentMessage(value: unknown): value is { item: { type: "agent_message"; text: string } } {
  return isRecord(value) && value.type === "item.completed" && isRecord(value.item)
    && value.item.type === "agent_message" && typeof value.item.text === "string";
}

function codexErrorMessage(record: Record<string, unknown>): string {
  if (typeof record.message === "string") return `Codex CLI error: ${record.message}`;
  if (isRecord(record.error) && typeof record.error.message === "string") return `Codex CLI error: ${record.error.message}`;
  return `Codex CLI reported ${String(record.type)}`;
}

function normalizeCodexRecord(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.item)) return undefined;
  const item = value.item;
  if (item.type !== "command_execution") return undefined;
  const tool = typeof item.command === "string" ? item.command : "command";
  if (value.type === "item.started") return { type: "tool_started", tool };
  if (value.type === "item.completed") return { type: "tool_finished", tool, success: item.status === "completed" };
  return undefined;
}

function parseStructuredMessage(message: string): unknown {
  const trimmed = message.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  try { return JSON.parse(fenced?.[1] ?? trimmed); }
  catch (error) { throw new Error("Codex final message is not valid structured JSON", { cause: error }); }
}

function processCwd(session: CodexTransportSession): string {
  const cwd = (session as CodexTransportSession & { readonly cwd?: unknown }).cwd;
  if (typeof cwd !== "string") throw new Error(`Cannot resume Codex session without its working directory: ${session.id}`);
  return cwd;
}
