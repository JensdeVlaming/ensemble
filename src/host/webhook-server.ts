import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { OperationalEventReporter } from "../domain/observability.ts";
import { emitOperational } from "../observability/logging.ts";

export interface WebhookRoute {
  readonly path: string;
  readonly repositoryId: string;
  readonly username: string;
  readonly password: string;
}

export interface WebhookServerOptions {
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly routes: readonly WebhookRoute[];
  readonly requestWake: (repositoryId: string) => void;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly events?: OperationalEventReporter;
}

export interface WebhookServerStartReport {
  readonly endpoints: readonly string[];
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class WebhookServer {
  readonly #host: string;
  readonly #port: number;
  readonly #publicBaseUrl: URL;
  readonly #routes: ReadonlyMap<string, WebhookRegistration>;
  readonly #requestWake: (repositoryId: string) => void;
  readonly #maxBodyBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #events?: OperationalEventReporter;
  #server?: Server;
  #start?: Promise<WebhookServerStartReport>;
  #close?: Promise<void>;

  constructor(options: WebhookServerOptions) {
    this.#host = requireText(options.host, "Webhook host");
    this.#port = boundedInteger(options.port, 0, 65_535, "Webhook port");
    this.#publicBaseUrl = publicBaseUrl(options.publicBaseUrl);
    this.#routes = validateRoutes(options.routes);
    this.#requestWake = options.requestWake;
    this.#maxBodyBytes = boundedInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 1, Number.MAX_SAFE_INTEGER,
      "Webhook maximum body bytes");
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 1,
      MAX_TIMER_DELAY_MS, "Webhook request timeout");
    this.#closeTimeoutMs = boundedInteger(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS, 1,
      MAX_TIMER_DELAY_MS, "Webhook close timeout");
    this.#events = options.events;
  }

  start(): Promise<WebhookServerStartReport> {
    if (this.#close) return Promise.reject(new Error("Cannot start a closed webhook server"));
    this.#start ??= this.#listen();
    return this.#start;
  }

  close(): Promise<void> {
    this.#close ??= this.#stop();
    return this.#close;
  }

  async #listen(): Promise<WebhookServerStartReport> {
    const server = createServer((request, response) => { void this.#handle(request, response); });
    this.#server = server;
    server.requestTimeout = this.#requestTimeoutMs;
    server.headersTimeout = this.#requestTimeoutMs;
    server.keepAliveTimeout = Math.min(this.#requestTimeoutMs, 5_000);
    server.maxHeadersCount = 64;
    server.on("clientError", (_error, socket) => {
      if (!socket.writable) return;
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
      const onListening = (): void => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#port, this.#host);
    });
    const endpoints = Object.freeze([...this.#routes.keys()].sort().map((path) => endpoint(this.#publicBaseUrl, path)));
    for (const path of [...this.#routes.keys()].sort()) {
      const route = this.#routes.get(path)!;
      this.#emit({ level: "info", event: "webhook.server_started", repositoryId: route.repositoryId,
        data: { endpoint: endpoint(this.#publicBaseUrl, path) } });
    }
    return Object.freeze({ endpoints });
  }

  async #stop(): Promise<void> {
    await this.#start?.catch(() => undefined);
    const server = this.#server;
    if (!server) return;
    if (!server.listening) {
      this.#server = undefined;
      return;
    }
    server.closeIdleConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => { server.closeAllConnections(); }, this.#closeTimeoutMs);
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#server = undefined;
    }
    this.#emit({ level: "info", event: "webhook.server_stopped" });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Connection", "close");
    const path = request.url?.split("?", 1)[0] ?? "";
    const route = this.#routes.get(path);
    if (!route) {
      this.#reject(response, 404, request.method, path);
      request.resume();
      return;
    }
    const repositoryId = route.repositoryId;
    if (!authorized(request.headers.authorization, route.authorizationDigest)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="ensemble-webhook"');
      this.#reject(response, 401, request.method, path, repositoryId);
      request.resume();
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      this.#reject(response, 405, request.method, path, repositoryId);
      request.resume();
      return;
    }
    const declaredLength = request.headers["content-length"];
    if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength)
      || Number(declaredLength) > this.#maxBodyBytes)) {
      this.#reject(response, declaredLength !== undefined && /^\d+$/u.test(declaredLength) ? 413 : 400,
        request.method, path, repositoryId);
      request.resume();
      return;
    }
    const bodyStatus = await readBoundedBody(request, this.#maxBodyBytes);
    if (bodyStatus !== "complete") {
      this.#reject(response, bodyStatus === "too_large" ? 413 : 400, request.method, path, repositoryId);
      return;
    }
    try {
      this.#requestWake(repositoryId);
    } catch {
      this.#reject(response, 503, request.method, path, repositoryId);
      return;
    }
    response.writeHead(202, { "Content-Length": "0" });
    response.end();
    this.#emit({ level: "info", event: "webhook.request_accepted", repositoryId,
      data: { method: "POST", endpoint: path, httpStatus: 202 } });
  }

  #reject(response: ServerResponse, status: number, method: string | undefined, path: string,
    repositoryId?: string): void {
    response.writeHead(status, { "Content-Length": "0" });
    response.end();
    this.#emit({ level: status >= 500 ? "warn" : "info", event: "webhook.request_rejected", repositoryId,
      data: { method: method ?? "", endpoint: safeEndpoint(path), httpStatus: status } });
  }

  #emit(event: Parameters<typeof emitOperational>[1]): void { emitOperational(this.#events, event); }
}

interface WebhookRegistration {
  readonly repositoryId: string;
  readonly authorizationDigest: Buffer;
}

function validateRoutes(routes: readonly WebhookRoute[]): ReadonlyMap<string, WebhookRegistration> {
  if (routes.length === 0) throw new Error("At least one webhook route is required");
  const output = new Map<string, WebhookRegistration>();
  for (const route of routes) {
    if (!route.path.startsWith("/") || route.path.length > 1_024 || /[?#\0\r\n]/u.test(route.path)) {
      throw new Error(`Invalid webhook route path: ${safeEndpoint(route.path)}`);
    }
    if (output.has(route.path)) throw new Error(`Duplicate webhook route path: ${route.path}`);
    const username = requireText(route.username, "Webhook username");
    const password = requireText(route.password, "Webhook password");
    output.set(route.path, Object.freeze({
      repositoryId: requireText(route.repositoryId, "Webhook repository ID"),
      authorizationDigest: digest(`Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`),
    }));
  }
  return output;
}

function authorized(value: string | undefined, expected: Buffer): boolean {
  return timingSafeEqual(digest(value ?? ""), expected);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function readBoundedBody(request: IncomingMessage, maximumBytes: number): Promise<"complete" | "too_large" | "invalid"> {
  return new Promise((resolve) => {
    let bytes = 0;
    let settled = false;
    const settle = (result: "complete" | "too_large" | "invalid"): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (bytes > maximumBytes) {
        settle("too_large");
        request.resume();
      }
    });
    request.once("end", () => settle("complete"));
    request.once("aborted", () => settle("invalid"));
    request.once("error", () => settle("invalid"));
  });
}

function endpoint(base: URL, path: string): string {
  return new URL(path, base).toString();
}

function publicBaseUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(requireText(value, "Webhook public base URL")); }
  catch { throw new Error("Webhook public base URL must be an absolute HTTPS URL"); }
  if (parsed.protocol !== "https:") throw new Error("Webhook public base URL must be an absolute HTTPS URL");
  if (parsed.username || parsed.password) throw new Error("Webhook public base URL must not contain credentials");
  return parsed;
}

function safeEndpoint(path: string): string {
  return /^[\x20-\x7e]{0,1024}$/u.test(path) ? path : "[INVALID]";
}

function requireText(value: string, name: string): string {
  if (!value.trim() || /[\0\r\n]/u.test(value)) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
