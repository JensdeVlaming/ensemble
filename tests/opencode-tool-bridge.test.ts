import assert from "node:assert/strict";
import test from "node:test";
import { startOpenCodeToolBridge } from "../src/index.ts";

test("OpenCode tool bridge exposes scoped MCP tools and revokes the capability on close", async () => {
  const inputs: unknown[] = [];
  const bridge = await startOpenCodeToolBridge([{ name: "provider_context", description: "Read provider context",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    invoke: async (input) => { inputs.push(input); return { state: "ready" }; } }], "ensemble-test");
  assert.equal(bridge.name, "ensemble-test");
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{64}$/u);

  const initialized = await rpc(bridge.url, 1, "initialize", {});
  assert.ok(initialized.result?.serverInfo);
  assert.equal(initialized.result.serverInfo.name, "ensemble");
  const listed = await rpc(bridge.url, 2, "tools/list", {});
  assert.ok(listed.result?.tools);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["provider_context"]);
  const called = await rpc(bridge.url, 3, "tools/call", { name: "provider_context", arguments: { id: "1" } });
  assert.ok(called.result);
  assert.deepEqual(inputs, [{ id: "1" }]);
  assert.deepEqual(called.result.structuredContent, { state: "ready" });
  const unknown = await rpc(bridge.url, 4, "tools/call", { name: "missing", arguments: {} });
  assert.ok(unknown.error);
  assert.equal(unknown.error.code, -32602);
  bridge.deactivate();
  const inactive = await rpc(bridge.url, 5, "tools/call", { name: "provider_context", arguments: { id: "2" } });
  assert.equal(inactive.error?.code, -32000);
  bridge.activate();
  assert.ok((await rpc(bridge.url, 6, "tools/call", { name: "provider_context", arguments: { id: "3" } })).result);

  await bridge.close();
  await bridge.close();
  await assert.rejects(fetch(bridge.url, { method: "POST", body: "{}" }));
});

test("OpenCode tool bridge aborts an accepted callback when the capability is revoked", async () => {
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => { started = resolve; });
  let observedSignal: AbortSignal | undefined;
  const bridge = await startOpenCodeToolBridge([{
    name: "wait_until_cancelled", description: "Waits for cancellation", inputSchema: { type: "object" },
    invoke: async (_input, context) => {
      observedSignal = context?.signal;
      started();
      await new Promise<void>((resolve) => context?.signal.addEventListener("abort", () => resolve(), { once: true }));
      context?.signal.throwIfAborted();
      return {};
    },
  }]);
  const pending = rpc(bridge.url, 1, "tools/call", { name: "wait_until_cancelled", arguments: {} }).catch(() => undefined);
  await invoked;
  bridge.deactivate();
  assert.equal(observedSignal?.aborted, true);
  await pending;
  await bridge.close();
});

async function rpc(url: string, id: number, method: string, params: unknown): Promise<RpcResponse> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  assert.equal(response.status, 200);
  return response.json() as Promise<RpcResponse>;
}

interface RpcResponse {
  readonly result?: { readonly serverInfo?: { readonly name: string }; readonly tools?: Array<{ readonly name: string }>; readonly structuredContent?: unknown };
  readonly error?: { readonly code: number };
}
