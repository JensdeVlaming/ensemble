import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import test from "node:test";
import { OpenCodeServerTransport } from "../src/index.ts";
import type { OpenCodeServerLauncher, OpenCodeServerProcess } from "../src/index.ts";

class FakeProcess implements OpenCodeServerProcess {
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly server: Server;
  readonly requests: Array<{ path: string; body?: unknown; directory?: string; authorization?: string }> = [];
  eventResponse?: ServerResponse;
  killed = false;
  readonly emitIdle: boolean;
  readonly messageDelayMs: number;
  readonly stallEvents: boolean;
  readonly connectMcp: boolean;
  mcpResult?: unknown;
  #resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  constructor(port: number, options: { emitIdle: boolean; messageDelayMs: number; stallEvents: boolean; connectMcp: boolean }) {
    this.emitIdle = options.emitIdle;
    this.messageDelayMs = options.messageDelayMs;
    this.stallEvents = options.stallEvents;
    this.connectMcp = options.connectMcp;
    this.exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.listen(port, "127.0.0.1");
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.killed) return;
    this.killed = true;
    this.eventResponse?.end();
    this.server.closeAllConnections();
    this.server.close();
    this.#resolveExit({ code: null, signal });
  }
  async handle(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? "";
    let body: unknown;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    this.requests.push({ path, ...(body === undefined ? {} : { body }),
      ...(typeof request.headers["x-opencode-directory"] === "string" ? { directory: request.headers["x-opencode-directory"] } : {}),
      ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}) });
    if (path === "/global/health") return json(response, { healthy: true, version: "1.18.31" });
    if (path === "/session") return json(response, { id: "session-1" });
    if (path === "/event") {
      if (this.stallEvents) return;
      this.eventResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    if (path === "/session/session-1/message") {
      this.emit({ type: "message.part.updated", properties: { part: { sessionID: "session-1", type: "tool", tool: "npm test", state: { status: "running" } } } });
      this.emit({ type: "message.part.updated", properties: { part: { sessionID: "session-1", type: "tool", tool: "npm test", state: { status: "completed" } } } });
      if (this.emitIdle) this.emit({ type: "session.idle", properties: { sessionID: "session-1" } });
      if (this.messageDelayMs) await new Promise((resolve) => setTimeout(resolve, this.messageDelayMs));
      return json(response, { info: { structured: { outcome: "approved", summary: "done", comments: [], artifacts: [] } }, parts: [] });
    }
    if (path === "/mcp" && this.connectMcp) {
      const registration = body as { name: string; config: { url: string } };
      await bridgeRpc(registration.config.url, "initialize", {});
      this.mcpResult = await bridgeRpc(registration.config.url, "tools/call", { name: "provider_context", arguments: { id: "task-1" } });
      return json(response, { [registration.name]: { status: "connected" } });
    }
    if (path === "/session/session-1/abort") return json(response, true);
    json(response, { error: "missing" }, 404);
  }
  emit(value: unknown): void { this.eventResponse?.write(`data: ${JSON.stringify(value)}\n\n`); }
}

class FakeLauncher implements OpenCodeServerLauncher {
  readonly processes: FakeProcess[] = [];
  executable?: string;
  arguments?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  emitIdle = true;
  messageDelayMs = 0;
  stallEvents = false;
  connectMcp = false;
  launch(executable: string, arguments_: readonly string[], options: { cwd: string; environment: Readonly<Record<string, string>> }): FakeProcess {
    this.executable = executable; this.arguments = arguments_; this.environment = options.environment;
    const port = Number(arguments_[arguments_.indexOf("--port") + 1]);
    const process = new FakeProcess(port, { emitIdle: this.emitIdle, messageDelayMs: this.messageDelayMs,
      stallEvents: this.stallEvents, connectMcp: this.connectMcp });
    this.processes.push(process); return process;
  }
}

test("OpenCode server transport performs health-only diagnostics", async () => {
  const launcher = new FakeLauncher();
  const transport = new OpenCodeServerTransport({ launcher, executable: "/opencode", environment: { HOME: "/home" } });
  await transport.diagnose("/configuration");
  assert.deepEqual(launcher.arguments, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", launcher.arguments?.at(-1)]);
  assert.equal(launcher.environment?.HOME, "/home");
  assert.match(launcher.environment?.OPENCODE_SERVER_PASSWORD ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.match(launcher.processes[0]?.requests[0]?.authorization ?? "", /^Basic /u);
  assert.deepEqual(launcher.processes[0]?.requests.map((request) => request.path), ["/global/health"]);
  assert.equal(launcher.processes[0]?.killed, true);
});

test("OpenCode server transport sends model/schema, streams correlated events, and cancels", async () => {
  const launcher = new FakeLauncher();
  const transport = new OpenCodeServerTransport({ launcher, requestTimeoutMs: 2_000 });
  const session = await transport.start({ id: "run", cwd: "/workspace", prompt: "work",
    config: { model: "openai/gpt-5.6-sol", operatorRequests: "reject" }, tools: [] });
  const messages = await collect(session.messages);
  assert.deepEqual(await session.result, { outcome: "approved", summary: "done", comments: [], artifacts: [] });
  assert.deepEqual(messages, [
    { type: "tool_started", tool: "npm test" },
    { type: "tool_finished", tool: "npm test", success: true },
  ]);
  const prompt = launcher.processes[0]?.requests.find((request) => request.path.endsWith("/message"));
  const body = prompt?.body as { model?: unknown; format?: { type?: string }; parts?: unknown[] };
  assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-5.6-sol" });
  assert.equal(body.format?.type, "json_schema");
  assert.equal(body.parts?.length, 1);
  assert.equal(prompt?.directory, "/workspace");
  await transport.cancel(session);
  assert.equal(launcher.processes[0]?.requests.some((request) => request.path.endsWith("/abort")), true);
  assert.equal(launcher.processes[0]?.killed, true);
});

test("OpenCode server configuration is strict and model selection is repository-owned", () => {
  const transport = new OpenCodeServerTransport();
  transport.validateConfiguration({});
  transport.validateConfiguration({ model: "anthropic/claude-sonnet-4", operatorRequests: "auto", automaticApprovals: ["read"] });
  assert.throws(() => transport.validateConfiguration({ model: "missing-provider" }), /provider\/model/u);
  assert.throws(() => transport.validateConfiguration({ unknown: true }), /Unknown OpenCode/u);
  assert.throws(() => transport.validateConfiguration({ automaticApprovals: ["read"] }), /requires operatorRequests/u);
});

test("OpenCode model turns outlive control requests and complete without session.idle", async () => {
  const launcher = new FakeLauncher();
  launcher.emitIdle = false;
  launcher.messageDelayMs = 75;
  const transport = new OpenCodeServerTransport({ launcher, requestTimeoutMs: 25 });
  const session = await transport.start({ id: "run", cwd: "/workspace", prompt: "work", config: {}, tools: [] });
  await collect(session.messages);
  assert.equal((await session.result as { outcome: string }).outcome, "approved");
  await transport.cancel(session);
});

test("OpenCode bounds event-stream startup and cleans the child process", async () => {
  const launcher = new FakeLauncher();
  launcher.stallEvents = true;
  const transport = new OpenCodeServerTransport({ launcher, requestTimeoutMs: 25 });
  await assert.rejects(transport.start({ id: "run", cwd: "/workspace", prompt: "work", config: {}, tools: [] }));
  assert.equal(launcher.processes[0]?.killed, true);
});

test("OpenCode registers and invokes execution-scoped MCP tools", async () => {
  const launcher = new FakeLauncher();
  launcher.connectMcp = true;
  const inputs: unknown[] = [];
  const transport = new OpenCodeServerTransport({ launcher, requestTimeoutMs: 2_000 });
  const session = await transport.start({ id: "run", cwd: "/workspace", prompt: "work", config: {}, tools: [{
    name: "provider_context", description: "Read provider context", inputSchema: { type: "object" },
    invoke: async (input) => { inputs.push(input); return { ready: true }; },
  }] });
  await collect(session.messages);
  await session.result;
  assert.deepEqual(inputs, [{ id: "task-1" }]);
  assert.deepEqual((launcher.processes[0]?.mcpResult as { result?: { structuredContent?: unknown } }).result?.structuredContent, { ready: true });
  await transport.cancel(session);
});

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
async function collect(values: AsyncIterable<unknown>): Promise<unknown[]> { const output: unknown[] = []; for await (const value of values) output.push(value); return output; }
async function bridgeRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return response.json();
}
