import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeRuntime } from "../src/index.ts";
import type { OpenCodeRunRequest, OpenCodeTransport, OpenCodeTransportSession, RuntimeContext } from "../src/index.ts";

class FakeTransport implements OpenCodeTransport {
  requests: OpenCodeRunRequest[] = [];
  cancelled = false;
  validateConfiguration(_config: Readonly<Record<string, unknown>>): void {}
  async diagnose(_cwd: string): Promise<void> {}
  async start(request: OpenCodeRunRequest): Promise<OpenCodeTransportSession> {
    this.requests.push(request);
    return { id: "opencode-session", messages: messages(),
      result: Promise.resolve({ outcome: "approved", summary: "complete", comments: [], artifacts: [] }) };
  }
  async resume(_session: OpenCodeTransportSession, prompt: string): Promise<OpenCodeTransportSession> {
    return { id: "opencode-session", messages: messages(),
      result: Promise.resolve({ outcome: "approved", summary: prompt, comments: [], artifacts: [] }) };
  }
  async cancel(_session: OpenCodeTransportSession): Promise<void> { this.cancelled = true; }
}

async function* messages(): AsyncIterable<unknown> {
  yield { type: "tool_started", tool: "provider_context" };
  yield { type: "tool_finished", tool: "provider_context", success: true };
}

test("OpenCode runtime constructs context, emits portable events, resumes, and cancels", async () => {
  const transport = new FakeTransport();
  const runtime = new OpenCodeRuntime(transport);
  const prepared = await runtime.prepare(context({ model: "openai/gpt-5.6-sol", operatorRequests: "reject" }));
  assert.equal(prepared.operatorRequests, "reject");
  const session = await runtime.start(prepared);
  const events = await collect(session.events);
  assert.deepEqual(await session.result, { outcome: "approved", summary: "complete", comments: [], artifacts: [] });
  assert.deepEqual(events.map((event) => event.type), ["run_started", "tool_started", "tool_finished", "run_completed"]);
  assert.equal(events.every((event) => event.executionId === "execution-1"), true);
  assert.match(transport.requests[0]?.prompt ?? "", /AGENTS/u);
  assert.match(transport.requests[0]?.prompt ?? "", /Acceptance/u);
  assert.doesNotMatch(transport.requests[0]?.prompt ?? "", /invoke/u);

  const resumed = await runtime.resume(session, { reason: "new_context", comments: [], artifacts: [] });
  await collect(resumed.events);
  assert.match((await resumed.result).summary, /Resume reason/u);
  await runtime.cancel(resumed);
  assert.equal(transport.cancelled, true);
});

test("OpenCode runtime rejects invalid policy and malformed structured results", async () => {
  const transport = new FakeTransport();
  const runtime = new OpenCodeRuntime(transport);
  assert.throws(() => runtime.validateConfiguration({ operatorRequests: "wait" }), /operatorRequests/u);
  transport.start = async () => ({ id: "bad", messages: (async function* () {})(),
    result: Promise.resolve({ outcome: "approved", summary: "done", comments: [], artifacts: [], extra: true }) });
  const session = await runtime.start(await runtime.prepare(context({})));
  await collect(session.events);
  await assert.rejects(session.result, /unknown field/u);
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> { const output: T[] = []; for await (const value of values) output.push(value); return output; }

function context(runtimeConfig: Readonly<Record<string, unknown>>): RuntimeContext {
  return {
    executionId: "execution-1", repository: { id: "ensemble", url: "https://example.test/ensemble.git" },
    workspace: { root: "/workspace", repositoryPath: "/workspace", runtimePath: "/workspace/.runtime" },
    task: { id: "1", title: "Work", description: "Acceptance", acceptanceCriteria: ["Done"], status: "ready", labels: [], assignees: [],
      repository: { id: "ensemble", url: "https://example.test/ensemble.git" } },
    comments: [], artifacts: [], workflow: { instructions: "Work", roles: [] }, agents: "AGENTS",
    role: { name: "implementation", instructions: "Implement" }, runtimeConfig,
    tools: [{ name: "provider_context", description: "Read context", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      invoke: async () => ({ ok: true }) }],
  };
}
