import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RuntimeTool } from "../../domain/model.ts";

const MAX_REQUEST_BYTES = 1_048_576;

export interface OpenCodeToolBridge {
  readonly name: string;
  readonly url: string;
  activate(): void;
  deactivate(): void;
  close(): Promise<void>;
}

export async function startOpenCodeToolBridge(
  tools: readonly RuntimeTool[],
  name = `ensemble-${randomBytes(12).toString("hex")}`,
): Promise<OpenCodeToolBridge> {
  const capability = randomBytes(32).toString("hex");
  const path = `/mcp/${capability}`;
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  let active = true;
  let closed = false;
  const server = createServer((request, response) => {
    void handleRequest(request, response, path, available, () => closed, () => active).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Ensemble tool bridge failed" }));
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return Object.freeze({
    name,
    url: `http://127.0.0.1:${address.port}${path}`,
    activate: () => { if (!closed) active = true; },
    deactivate: () => { active = false; },
    close: async () => {
      if (closed) return;
      closed = true;
      active = false;
      available.clear();
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
    },
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  tools: ReadonlyMap<string, RuntimeTool>,
  isClosed: () => boolean,
  isActive: () => boolean,
): Promise<void> {
  if (request.url !== path || isClosed()) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  let body: unknown;
  try { body = JSON.parse(await readBody(request)); }
  catch {
    writeJson(response, 400, rpcError(null, -32700, "Invalid JSON-RPC request"));
    return;
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    writeJson(response, 400, rpcError(rpcId(body), -32600, "Invalid JSON-RPC request"));
    return;
  }
  if (body.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const id = rpcId(body);
  if (body.method === "initialize") {
    writeJson(response, 200, rpcResult(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ensemble", version: "0.1.0" },
    }));
    return;
  }
  if (body.method === "ping") {
    writeJson(response, 200, rpcResult(id, {}));
    return;
  }
  if (body.method === "tools/list") {
    writeJson(response, 200, rpcResult(id, { tools: [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })) }));
    return;
  }
  if (body.method === "tools/call") {
    if (!isActive()) {
      writeJson(response, 200, rpcError(id, -32000, "Ensemble tool capability is inactive"));
      return;
    }
    const params = isRecord(body.params) ? body.params : undefined;
    const tool = typeof params?.name === "string" ? tools.get(params.name) : undefined;
    if (!tool) {
      writeJson(response, 200, rpcError(id, -32602, "Unknown Ensemble tool"));
      return;
    }
    try {
      const result = await tool.invoke(params?.arguments ?? {});
      writeJson(response, 200, rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(isRecord(result) ? { structuredContent: result } : {}),
        isError: false,
      }));
    } catch {
      writeJson(response, 200, rpcResult(id, {
        content: [{ type: "text", text: "Ensemble tool invocation failed" }],
        isError: true,
      }));
    }
    return;
  }
  writeJson(response, 200, rpcError(id, -32601, "Unsupported MCP method"));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("MCP request exceeds maximum size");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function rpcResult(id: string | number | null, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcId(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
