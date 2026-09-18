import assert from "node:assert/strict";
import { request } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import test from "node:test";
import type { OperationalEvent } from "../src/domain/observability.ts";
import { WebhookServer } from "../src/host/webhook-server.ts";

const username = "webhook-user";
const password = "webhook-password";
const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

test("webhook routes exact authenticated POST requests to repository wakes without reading payload semantics", async () => {
  const port = await availablePort();
  const wakes: string[] = [];
  const events: OperationalEvent[] = [];
  const server = new WebhookServer({
    host: "127.0.0.1",
    port,
    publicBaseUrl: "https://hooks.example.test/ignored-prefix/",
    routes: [
      { path: "/hooks/repository-b", repositoryId: "repository-b", username: "other-user", password: "other-password" },
      { path: "/hooks/repository-a", repositoryId: "repository-a", username, password },
    ],
    requestWake: (repositoryId) => { wakes.push(repositoryId); },
    events: { emit: (event) => { events.push(event); } },
  });
  const started = await server.start();
  const endpoint = `http://127.0.0.1:${port}/hooks/repository-a`;

  assert.deepEqual(started.endpoints.map((value) => new URL(value).pathname),
    ["/hooks/repository-a", "/hooks/repository-b"]);
  assert.ok(started.endpoints.every((value) => value.startsWith("https://hooks.example.test/")));
  assert.doesNotMatch(JSON.stringify(started), /webhook-user|webhook-password/u);
  const accepted = await send(endpoint, { method: "POST", authorization, body: "{not-json" });
  assert.equal(accepted.status, 202);
  assert.deepEqual(wakes, ["repository-a"]);
  assert.ok(events.some((event) => event.event === "webhook.server_started"
    && event.repositoryId === "repository-a" && event.data?.endpoint === "https://hooks.example.test/hooks/repository-a"));
  assert.doesNotMatch(JSON.stringify(events), /webhook-user|webhook-password|not-json/u);

  await server.close();
  assert.ok(events.some((event) => event.event === "webhook.server_stopped"));
});

test("webhook responses distinguish authentication, exact routes, methods, body bounds, and unavailable intake", async () => {
  const port = await availablePort();
  let unavailable = false;
  const server = new WebhookServer({
    host: "127.0.0.1",
    port,
    publicBaseUrl: "https://hooks.example.test",
    routes: [{ path: "/hooks/repository", repositoryId: "repository", username, password }],
    maxBodyBytes: 4,
    requestWake: () => { if (unavailable) throw new Error("draining"); },
  });
  await server.start();
  const endpoint = `http://127.0.0.1:${port}/hooks/repository`;

  assert.equal((await send(endpoint!, { method: "POST", body: "ok" })).status, 401);
  assert.equal((await send(new URL("/hooks/repository-extra", endpoint).href,
    { method: "POST" })).status, 404);
  const method = await send(endpoint!, { method: "GET", authorization });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "POST");
  assert.equal((await send(endpoint!, { method: "POST", authorization, body: "12345", setContentLength: false })).status, 413);
  unavailable = true;
  assert.equal((await send(endpoint!, { method: "POST", authorization, body: "ok" })).status, 503);

  await server.close();
});

test("webhook rejects malformed HTTP with 400 and validates exact route configuration", async () => {
  assert.throws(() => new WebhookServer({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://hooks.example.test",
    routes: [{ path: "/duplicate", repositoryId: "a", username, password },
      { path: "/duplicate", repositoryId: "b", username, password }],
    requestWake: () => undefined }), /Duplicate webhook route/u);
  assert.throws(() => new WebhookServer({ host: "127.0.0.1", port: 0, publicBaseUrl: "https://hooks.example.test",
    routes: [{ path: "/hooks/repository?ambiguous", repositoryId: "repository", username, password }], requestWake: () => undefined }),
  /Invalid webhook route/u);

  const port = await availablePort();
  const server = new WebhookServer({ host: "127.0.0.1", port, publicBaseUrl: "https://hooks.example.test",
    routes: [{ path: "/hooks/repository", repositoryId: "repository", username, password }], requestWake: () => undefined });
  await server.start();
  assert.match(await malformedRequest(new URL(`http://127.0.0.1:${port}/hooks/repository`)), /^HTTP\/1\.1 400 Bad Request/u);
  await server.close();
});

test("webhook close owns startup races and bounds open connections", async () => {
  const port = await availablePort();
  const server = new WebhookServer({ host: "127.0.0.1", port, publicBaseUrl: "https://hooks.example.test", closeTimeoutMs: 10,
    routes: [{ path: "/hooks/repository", repositoryId: "repository", username, password }], requestWake: () => undefined });
  const starting = server.start();
  const closing = server.close();
  await starting;
  await closing;
  await assert.rejects(send(`http://127.0.0.1:${port}/hooks/repository`, { method: "POST", authorization }), /ECONNREFUSED|socket hang up/u);
  await assert.rejects(server.start(), /closed webhook server/u);

  const boundedPort = await availablePort();
  const bounded = new WebhookServer({ host: "127.0.0.1", port: boundedPort, publicBaseUrl: "https://hooks.example.test", closeTimeoutMs: 10,
    routes: [{ path: "/hooks/repository", repositoryId: "repository", username, password }], requestWake: () => undefined });
  await bounded.start();
  const target = new URL(`http://127.0.0.1:${boundedPort}/hooks/repository`);
  const socket = connect(Number(target.port), target.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const socketClosed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); });
  await bounded.close();
  await socketClosed;
  assert.equal(socket.destroyed, true);
});

function send(url: string, options: { readonly method: string; readonly authorization?: string; readonly body?: string;
  readonly setContentLength?: boolean }):
Promise<{ readonly status: number; readonly headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body ?? "";
    const outgoing = request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers: {
        ...(options.authorization ? { authorization: options.authorization } : {}),
        ...(body && options.setContentLength !== false ? { "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Test server did not bind a TCP port"));
        return;
      }
      server.close((error) => { if (error) reject(error); else resolve(address.port); });
    });
  });
}

function malformedRequest(endpoint: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`POST ${endpoint.pathname} HTTP/1.1\r\nHost: ${endpoint.host}\r\nContent-Length: invalid\r\n\r\n`);
    });
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}
