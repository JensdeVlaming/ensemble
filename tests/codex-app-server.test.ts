import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerTransport, CodexRuntime } from "../src/index.ts";
import type { CodexAppServerLauncher, CodexAppServerProcess, RuntimeContext, RuntimeTool } from "../src/index.ts";

class Stream implements AsyncIterable<string> {
  readonly values: string[] = [];
  readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  push(value: string): void { const waiter = this.waiters.shift(); if (waiter) waiter({ done: false, value }); else this.values.push(value); }
  [Symbol.asyncIterator](): AsyncIterator<string> { return { next: () => {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    return new Promise((resolve) => this.waiters.push(resolve));
  } }; }
}

interface FakeOptions {
  readonly onTurn?: (server: FakeServer, request: Record<string, unknown>, turnId: string) => void;
  readonly ignoreMethods?: readonly string[];
}

class FakeServer implements CodexAppServerProcess {
  readonly stdout = new Stream();
  readonly writes: Record<string, unknown>[] = [];
  readonly stdin = { write: (line: string) => { this.receive(JSON.parse(line) as Record<string, unknown>); return true; } };
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly options: FakeOptions;
  #resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  #turn = 0;
  killed = false;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    this.exit = new Promise((resolve) => { this.#resolveExit = resolve; });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void { this.killed = true; this.#resolveExit({ code: null, signal }); }

  send(value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    const middle = Math.floor(line.length / 2);
    this.stdout.push(line.slice(0, middle));
    this.stdout.push(line.slice(middle));
  }

  receive(request: Record<string, unknown>): void {
    this.writes.push(request);
    if (typeof request.method === "string" && this.options.ignoreMethods?.includes(request.method)) return;
    const id = request.id;
    if (request.method === "initialize") this.send({ id, result: { platformFamily: "unix", platformOs: "macos" } });
    if (request.method === "thread/start") this.send({ id, result: { thread: { id: "thread-1" } } });
    if (request.method === "turn/start") {
      const turnId = `turn-${++this.#turn}`;
      this.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } } });
      this.send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      this.options.onTurn?.(this, request, turnId);
    }
    if (request.method === "turn/interrupt") this.send({ id, result: {} });
  }
}

class Launcher implements CodexAppServerLauncher {
  readonly servers: FakeServer[] = [];
  readonly options: FakeOptions;
  constructor(options: FakeOptions = {}) { this.options = options; }
  launch(_executable: string, _arguments: readonly string[], _options: { cwd: string; environment: Readonly<Record<string, string>> }): FakeServer {
    const server = new FakeServer(this.options); this.servers.push(server); return server;
  }
}

const result = { outcome: "approved", summary: "done", comments: [], artifacts: [] };
const request = { id: "run-1", cwd: "/workspace", prompt: "work", config: { operatorRequests: "reject" }, tools: [] };

test("Codex App Server initializes, correlates fragmented thread/turn messages, resumes, and cancels", async () => {
  const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
    server.send({ method: "item/started", params: { threadId: "thread-1", turnId,
      item: { id: "command-1", type: "commandExecution", command: "npm test", status: "inProgress" } } });
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: "command-1", type: "commandExecution", command: "npm test", status: "completed" } } });
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: "message-1", type: "agentMessage", text: JSON.stringify(result), phase: "final_answer" } } });
    server.send({ method: "turn/completed", params: { threadId: "thread-1",
      turn: { id: turnId, status: "completed", items: [] } } });
  } });
  const transport = new CodexAppServerTransport({ launcher, executable: "/codex", environment: { PATH: "/bin" } });
  const first = await transport.start(request);
  assert.deepEqual(await first.result, result);
  assert.deepEqual(await collect(first.messages), [
    { type: "tool_started", tool: "npm test" },
    { type: "tool_finished", tool: "npm test", success: true },
  ]);
  const second = await transport.resume(first, "continue");
  assert.deepEqual(await second.result, result);
  assert.equal(second.id, first.id);
  await transport.cancel(second);
  const methods = launcher.servers[0]!.writes.map((value) => value.method);
  assert.deepEqual(methods.slice(0, 4), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.equal(methods.filter((method) => method === "turn/start").length, 2);
});

test("Codex App Server invokes only captured dynamic tools and returns bounded portable output", async () => {
  let invoked = 0;
  const tool: RuntimeTool = { name: "task.read", description: "Read task", inputSchema: { type: "object" },
    invoke: async (input) => { invoked += 1; return { input: input as never, ok: true }; } };
  const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
    server.send({ id: 90, method: "item/tool/call", params: { threadId: "thread-1", turnId,
      tool: "task.read", arguments: { include: true } } });
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: "message-1", type: "agentMessage", text: JSON.stringify(result) } } });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  } });
  const transport = new CodexAppServerTransport({ launcher });
  await (await transport.start({ ...request, tools: [tool] })).result;
  await new Promise((resolve) => setImmediate(resolve));
  const response = launcher.servers[0]!.writes.find((value) => value.id === 90);
  assert.equal(invoked, 1);
  assert.equal((response?.result as { success?: unknown }).success, true);
  assert.match(JSON.stringify(response), /include/u);
  const threadStart = launcher.servers[0]!.writes.find((value) => value.method === "thread/start");
  assert.equal(((threadStart?.params as { dynamicTools?: Array<{ type?: unknown }> }).dynamicTools?.[0]?.type), "function");
});

test("Codex App Server surfaces blocking approvals and rejects malformed or unknown protocol data", async () => {
  const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
    server.send({ id: 91, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-1", turnId, itemId: "command-1", reason: "run tests",
    } });
    server.send({ id: 92, method: "item/fileChange/requestApproval", params: {
      threadId: "thread-1", turnId, itemId: "change-1",
    } });
    server.send({ id: 93, method: "item/permissions/requestApproval", params: {
      threadId: "thread-1", turnId, itemId: "permission-1",
    } });
    server.send({ id: 94, method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", turnId, requestId: "input-1",
    } });
    server.send({ id: 95, method: "mcpServer/elicitation/request", params: {
      threadId: "thread-1", turnId: null, message: "Choose a project",
    } });
  } });
  const transport = new CodexAppServerTransport({ launcher });
  const session = await transport.start({ ...request, config: { operatorRequests: "block" } });
  const iterator = session.messages[Symbol.asyncIterator]();
  const event = (await iterator.next()).value as { type: string; at: string; request: { kind: string; summary: string; requestId: string; createdAt: string } };
  assert.equal(event.type, "approval_requested");
  assert.equal(Number.isFinite(Date.parse(event.at)), true);
  assert.deepEqual(event.request, { kind: "approval", summary: "Codex requests approval for command execution: run tests",
    requestId: "command-1", createdAt: event.at });
  const remaining = await Promise.all(Array.from({ length: 4 }, () => iterator.next().then((entry) => entry.value as {
    type: string; request: { kind: string; requestId?: string; summary: string };
  })));
  assert.deepEqual(remaining.map((entry) => entry.type), ["approval_requested", "approval_requested",
    "user_input_requested", "tool_elicitation_requested"]);
  assert.deepEqual(remaining.map((entry) => entry.request.kind), ["approval", "approval", "user_input", "tool_elicitation"]);
  assert.equal(remaining[3]?.request.summary, "Choose a project");
  await transport.cancel(session);
  assert.throws(() => transport.validateConfiguration({ operatorRequests: "auto", automaticApprovals: ["network"] }), /automaticApprovals/u);
  assert.throws(() => transport.validateConfiguration({ unknown: true }), /Unknown/u);
});

test("Codex Runtime keeps one App Server thread across corrective turns and classifies exhaustion", async () => {
  let turns = 0;
  const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
    turns += 1;
    const output = turns === 1 ? {} : result;
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: `message-${turns}`, type: "agentMessage", text: JSON.stringify(output) } } });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  } });
  const runtime = new CodexRuntime(new CodexAppServerTransport({ launcher }));
  const prepared = await runtime.prepare(context({ operatorRequests: "reject", maxTurns: 2 }));
  const session = await runtime.start(prepared);
  const eventsPromise = collect(session.events);
  assert.deepEqual(await session.result, { ...result, nextRole: undefined });
  const events = await eventsPromise;
  assert.equal(turns, 2);
  await runtime.cancel(session);
  assert.equal(launcher.servers[0]?.killed, true);
  assert.equal(events.some((event) => (event as { type?: unknown }).type === "progress_updated"), true);

  turns = 0;
  const exhausted = new CodexRuntime(new CodexAppServerTransport({ launcher: new Launcher({ onTurn: (server, _request, turnId) => {
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: "bad", type: "agentMessage", text: "{}" } } });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  } }) }));
  const exhaustedSession = await exhausted.start(await exhausted.prepare(context({ operatorRequests: "reject", maxTurns: 1 })));
  const drain = collect(exhaustedSession.events);
  await assert.rejects(exhaustedSession.result, /exhausted 1 turns/u);
  await drain;
  await exhausted.cancel(exhaustedSession);
});

test("explicit Codex Runtime resume keeps the live thread and the original turn budget", async () => {
  const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: `message-${turnId}`, type: "agentMessage", text: JSON.stringify(result) } } });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  } });
  const runtime = new CodexRuntime(new CodexAppServerTransport({ launcher }));
  const first = await runtime.start(await runtime.prepare(context({ operatorRequests: "reject", maxTurns: 2 })));
  const firstEvents = collect(first.events);
  await first.result;
  await firstEvents;
  const resumed = await runtime.resume(first, { reason: "provider context changed", comments: [], artifacts: [] });
  const resumedEvents = collect(resumed.events);
  await resumed.result;
  await resumedEvents;
  assert.equal(resumed.id, first.id);
  assert.equal(launcher.servers[0]!.writes.filter((value) => value.method === "turn/start").length, 2);
  await assert.rejects(runtime.resume(resumed, { reason: "too many", comments: [], artifacts: [] }), /exhausted 2 turns/u);
  await runtime.cancel(resumed);
});

test("Codex App Server applies reject and narrowly configured automatic approval policies", async () => {
  for (const [config, expected] of [
    [{ operatorRequests: "reject" }, "decline"],
    [{ operatorRequests: "auto", automaticApprovals: ["command"] }, "accept"],
  ] as const) {
    const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
      server.send({ id: 77, method: "item/commandExecution/requestApproval", params: {
        threadId: "thread-1", turnId, itemId: "command-1",
      } });
      if (config.operatorRequests === "reject") server.send({ id: 78, method: "item/permissions/requestApproval", params: {
        threadId: "thread-1", turnId, itemId: "permission-1", environmentId: null, startedAtMs: 1,
        cwd: "/workspace", reason: null, permissions: {},
      } });
      server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
        item: { id: "message", type: "agentMessage", text: JSON.stringify(result) } } });
      server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
    } });
    const transport = new CodexAppServerTransport({ launcher });
    await (await transport.start({ ...request, config })).result;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(launcher.servers[0]!.writes.find((value) => value.id === 77)?.result, { decision: expected });
    if (config.operatorRequests === "reject") {
      assert.deepEqual(launcher.servers[0]!.writes.find((value) => value.id === 78)?.result, { permissions: {}, scope: "turn" });
    }
  }
});

test("Codex App Server projects usage and multi-bucket rate limits as portable runtime events", async () => {
  const launcher = new Launcher({ onTurn: (server, _request, turnId) => {
    server.send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId,
      tokenUsage: { total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5,
        reasoningOutputTokens: 0 }, last: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, outputTokens: 1,
        reasoningOutputTokens: 0 }, modelContextWindow: 200_000 } } });
    server.send({ method: "account/rateLimits/updated", params: { rateLimits: {
      limitId: "codex", limitName: null,
      primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_754_044_800 },
      secondary: { usedPercent: 50, windowDurationMins: 60, resetsAt: null },
      credits: null, individualLimit: null, planType: null, rateLimitReachedType: null,
    } } });
    server.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId,
      itemId: "message", delta: "working" } });
    server.send({ method: "item/completed", params: { threadId: "thread-1", turnId,
      item: { id: "message", type: "agentMessage", text: JSON.stringify(result) } } });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  } });
  const runtime = new CodexRuntime(new CodexAppServerTransport({ launcher }));
  const session = await runtime.start(await runtime.prepare(context({ operatorRequests: "reject" })));
  const events = await collect(session.events);
  await session.result;
  assert.equal(events.some((event) => (event as { type?: unknown; totalTokens?: unknown }).type === "usage_updated"
    && (event as { totalTokens?: unknown }).totalTokens === 15), true);
  assert.deepEqual(events.filter((event) => (event as { type?: unknown }).type === "rate_limit_updated")
    .map((event) => (event as { limitId: string }).limitId), ["codex:primary", "codex:secondary"]);
  assert.equal(events.some((event) => (event as { type?: unknown }).type === "heartbeat"), true);
});

test("Codex App Server fails closed on malformed data, correlation errors, early exit, and request timeout", async () => {
  const failures: readonly FakeOptions[] = [
    { onTurn: (server) => { server.stdout.push("{malformed}\n"); } },
    { onTurn: (server, _request, turnId) => { server.send({ method: "item/started", params: {
      threadId: "another-thread", turnId, item: { type: "commandExecution", command: "bad" },
    } }); } },
    { onTurn: (server) => { server.kill("SIGKILL"); } },
  ];
  for (const options of failures) {
    const transport = new CodexAppServerTransport({ launcher: new Launcher(options) });
    await assert.rejects(transport.start(request).then((session) => session.result), /Codex App Server/u);
  }
  const timeout = new CodexAppServerTransport({ launcher: new Launcher({ ignoreMethods: ["initialize"] }), requestTimeoutMs: 1 });
  await assert.rejects(timeout.start(request), /request timed out: initialize/u);
});

async function collect(values: AsyncIterable<unknown>): Promise<unknown[]> { const output: unknown[] = []; for await (const value of values) output.push(value); return output; }

function context(runtimeConfig: Readonly<Record<string, unknown>>): RuntimeContext {
  return {
    executionId: "execution-1", repository: { id: "ensemble", url: "https://example.test/ensemble.git" },
    workspace: { root: "/workspace", repositoryPath: "/workspace", runtimePath: "/workspace/.runtime" },
    task: { id: "1", title: "Work", description: "", acceptanceCriteria: [], status: "ready", labels: [], assignees: [],
      repository: { id: "ensemble", url: "https://example.test/ensemble.git" } },
    comments: [], artifacts: [], workflow: { instructions: "Work", roles: [] }, agents: "Rules",
    role: { name: "implementation", instructions: "Implement" }, runtimeConfig, tools: [],
  };
}
