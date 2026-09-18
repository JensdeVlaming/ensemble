import type { OperationalEventReporter } from "../../domain/observability.ts";
import { emitOperational } from "../../observability/logging.ts";

const MAX_RETRY_DELAY_MS = 30_000;

export interface AzureDevOpsClientOptions {
  readonly organization: string;
  readonly project: string;
  readonly pat: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly requestTimeoutMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
  readonly onEvent?: (event: AzureDevOpsClientEvent) => void;
  readonly operationalEvents?: OperationalEventReporter;
  readonly repositoryId?: string;
}

export type AzureDevOpsClientEvent =
  | Readonly<{ kind: "rate_limit"; method: string; path: string; status: 429; attempt: number;
      maxRetries: number; retryAfterMs?: number; willRetry: boolean }>
  | Readonly<{ kind: "request_retry"; method: string; path: string; status: number; attempt: number; delayMs: number }>;

export class AzureDevOpsApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = "AzureDevOpsApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class AzureDevOpsContinuationLimitError extends Error {
  readonly path: string;
  readonly limit: "pages" | "items";

  constructor(path: string, limit: "pages" | "items") {
    super(`Azure DevOps continuation ${limit} limit exceeded for ${path}`);
    this.name = "AzureDevOpsContinuationLimitError";
    this.path = path;
    this.limit = limit;
  }
}

export interface AzureDevOpsContinuationPage<T> {
  readonly items: readonly T[];
  readonly continuationToken?: string;
}

export class AzureDevOpsClient {
  readonly baseUrl: URL;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly requestTimeoutMs: number;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #onEvent?: (event: AzureDevOpsClientEvent) => void;
  readonly #operationalEvents?: OperationalEventReporter;
  readonly #repositoryId?: string;
  readonly #secrets: readonly string[];

  constructor(options: AzureDevOpsClientOptions) {
    const organization = requiredSegment(options.organization, "organization");
    const project = requiredSegment(options.project, "project");
    if (!options.pat.trim()) throw new Error("Azure DevOps PAT is required");
    this.baseUrl = new URL(`https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/`);
    this.#authorization = `Basic ${Buffer.from(`:${options.pat}`, "utf8").toString("base64")}`;
    this.#secrets = Object.freeze([options.pat, this.#authorization]);
    this.#fetch = options.fetch ?? fetch;
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? 3, "maxRetries");
    this.retryBaseMs = nonNegativeInteger(options.retryBaseMs ?? 250, "retryBaseMs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs");
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? (() => new Date());
    this.#onEvent = options.onEvent;
    this.#operationalEvents = options.operationalEvents;
    this.#repositoryId = options.repositoryId;
  }

  async request<T>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
    return jsonResponse<T>((await this.#responseWithRetries(method, path, body, contentType, method.toUpperCase() === "GET")).response);
  }

  async read<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return jsonResponse<T>((await this.#responseWithRetries(method, path, body, "application/json", true)).response);
  }

  async continuation<T>(
    path: string,
    select: (payload: unknown) => AzureDevOpsContinuationPage<T>,
    limits: Readonly<{ maxPages: number; maxItems: number }>,
  ): Promise<readonly T[]> {
    positiveInteger(limits.maxPages, "maxPages");
    positiveInteger(limits.maxItems, "maxItems");
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > limits.maxPages) throw new AzureDevOpsContinuationLimitError(path, "pages");
      const pagePath = withQuery(path, token === undefined ? {} : { continuationToken: token });
      const result = await this.#responseWithRetries("GET", pagePath, undefined, undefined, true);
      const payload = await jsonResponse<unknown>(result.response);
      const selected = select(payload);
      items.push(...selected.items);
      if (items.length > limits.maxItems) throw new AzureDevOpsContinuationLimitError(path, "items");
      const headerToken = result.response.headers.get("x-ms-continuationtoken") ?? undefined;
      const next = headerToken ?? selected.continuationToken;
      if (!next) return Object.freeze(items);
      if (next === token) throw new Error(`Azure DevOps continuation token did not advance for ${path}`);
      token = next;
    }
  }

  async workItemsBatch<T>(ids: readonly number[], fields: readonly string[], expand = "Relations"): Promise<readonly T[]> {
    const ordered = [...new Set(ids)].sort((left, right) => left - right);
    const result: T[] = [];
    for (let offset = 0; offset < ordered.length; offset += 200) {
      const batch = ordered.slice(offset, offset + 200);
      const response = await this.read<unknown>("POST", "_apis/wit/workitemsbatch", {
        ids: batch, fields: [...fields], "$expand": expand, errorPolicy: "Omit",
      });
      if (!response || typeof response !== "object" || !Array.isArray((response as { value?: unknown }).value)) {
        throw new Error("Azure DevOps work item batch response is invalid");
      }
      result.push(...(response as { value: T[] }).value);
    }
    return Object.freeze(result);
  }

  async patch<T>(path: string, operations: readonly Readonly<Record<string, unknown>>[]): Promise<T> {
    if (operations[0]?.op !== "test" || operations[0]?.path !== "/rev") {
      throw new Error("Azure DevOps work item patches must start with a revision test");
    }
    return this.request<T>("PATCH", path, operations, "application/json-patch+json");
  }

  async #responseWithRetries(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
    safeRead = false,
  ): Promise<{ response: Response }> {
    const normalizedMethod = method.toUpperCase();
    const eventPath = redactPath(path);
    let attempt = 1;
    while (true) {
      try {
        return { response: await this.#requestResponse(normalizedMethod, path, body, contentType) };
      } catch (error) {
        const retryable = error instanceof AzureDevOpsApiError && isRetryable(error.status);
        const willRetry = safeRead && retryable && attempt <= this.maxRetries;
        if (error instanceof AzureDevOpsApiError && error.status === 429) this.#emit(Object.freeze({
          kind: "rate_limit", method: normalizedMethod, path: eventPath, status: 429, attempt,
          maxRetries: this.maxRetries, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }), willRetry,
        }));
        if (!willRetry || !(error instanceof AzureDevOpsApiError)) throw error;
        const delayMs = error.retryAfterMs ?? Math.min(MAX_RETRY_DELAY_MS, this.retryBaseMs * (2 ** (attempt - 1)));
        this.#emit(Object.freeze({ kind: "request_retry", method: normalizedMethod, path: eventPath, status: error.status, attempt, delayMs }));
        attempt += 1;
        await this.#delay(delayMs);
      }
    }
  }

  async #requestResponse(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const safePath = redactPath(path);
    try {
      const response = await this.#fetch(apiUrl(this.baseUrl, path), {
        method,
        headers: {
          authorization: this.#authorization,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": contentType }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) return response;
      const payload = await safeJson(response);
      const code = stringProperty(payload, "typeKey") ?? stringProperty(payload, "errorCode");
      const detail = bounded(this.#redact(stringProperty(payload, "message") ?? response.statusText), 512);
      throw new AzureDevOpsApiError(`Azure DevOps ${method} ${safePath} failed (${response.status}): ${detail}`,
        response.status, code, retryAfterMilliseconds(response.headers, this.#now()));
    } catch (error) {
      if (error instanceof AzureDevOpsApiError) throw error;
      if (controller.signal.aborted) throw new AzureDevOpsApiError(`Azure DevOps ${method} ${safePath} timed out`, 408);
      throw new AzureDevOpsApiError(`Azure DevOps ${method} ${safePath} transport failed`, 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  #emit(event: AzureDevOpsClientEvent): void {
    try { this.#onEvent?.(event); } catch { /* Observers cannot alter provider behavior. */ }
    emitOperational(this.#operationalEvents, {
      level: "warn", event: event.kind === "rate_limit" ? "provider.rate_limited" : "provider.request_retry",
      provider: "azure-devops", ...(this.#repositoryId ? { repositoryId: this.#repositoryId } : {}),
      data: { method: event.method, endpoint: endpointClass(event.path), httpStatus: event.status,
        attempt: event.attempt, willRetry: event.kind === "rate_limit" ? event.willRetry : true,
        ...(event.kind === "request_retry" ? { delayMs: event.delayMs } : {}),
        ...(event.kind === "rate_limit" && event.retryAfterMs !== undefined ? { delayMs: event.retryAfterMs } : {}) },
    });
  }

  #redact(value: string): string {
    let result = value;
    for (const secret of this.#secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result;
  }
}

function apiUrl(base: URL, path: string): URL {
  const url = new URL(path.replace(/^\//u, ""), base);
  if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", "7.1");
  return url;
}

function withQuery(path: string, parameters: Readonly<Record<string, string>>): string {
  const url = new URL(path, "https://placeholder.invalid/");
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return `${url.pathname.replace(/^\//u, "")}${url.search}`;
}

function retryAfterMilliseconds(headers: Headers, now: Date): number | undefined {
  const value = headers.get("retry-after") ?? headers.get("x-ms-retry-after-ms");
  if (value === null) return undefined;
  if (/^\d+$/u.test(value)) {
    const milliseconds = headers.has("x-ms-retry-after-ms") ? Number(value) : Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? Math.min(milliseconds, MAX_RETRY_DELAY_MS) : MAX_RETRY_DELAY_MS;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.min(MAX_RETRY_DELAY_MS, Math.max(0, at - now.getTime()));
}

function redactPath(path: string): string {
  const url = new URL(path, "https://placeholder.invalid/");
  for (const key of [...url.searchParams.keys()]) {
    if (/token|authorization|pat|secret|key/iu.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return `${url.pathname}${url.search}`;
}

function endpointClass(path: string): string {
  const normalized = path.split("?", 1)[0]?.toLowerCase() ?? "";
  if (normalized.includes("workitemsbatch")) return "work_items_batch";
  if (normalized.includes("/comments")) return "work_item_comments";
  if (normalized.includes("/wiql/")) return "saved_query";
  if (normalized.includes("/workitems/")) return "work_item";
  if (normalized.includes("/fields/")) return "work_item_field";
  return "other";
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : typeof result === "number" ? String(result) : undefined;
}

function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function requiredSegment(value: string, name: string): string {
  if (!value.trim() || value.includes("/")) throw new Error(`Azure DevOps ${name} is invalid`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
