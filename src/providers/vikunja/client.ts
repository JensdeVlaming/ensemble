export interface VikunjaClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly perPage?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly requestTimeoutMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
  readonly onEvent?: (event: VikunjaClientEvent) => void;
}

export type VikunjaClientEvent =
  | {
    readonly kind: "rate_limit";
    readonly method: string;
    readonly path: string;
    readonly status: 429;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly retryAfterMs?: number;
    readonly willRetry: boolean;
  }
  | {
    readonly kind: "request_retry";
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly attempt: number;
    readonly delayMs: number;
  };

export interface VikunjaObserverError {
  readonly name: string;
  readonly message: string;
  readonly event: VikunjaClientEvent;
}

export interface VikunjaPaginationLimits {
  readonly maxPages: number;
  readonly maxItems: number;
}

export class VikunjaApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, code?: number, retryAfterMs?: number) {
    super(message);
    this.name = "VikunjaApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class VikunjaPaginationLimitError extends Error {
  readonly path: string;
  readonly limit: "pages" | "items";

  constructor(path: string, limit: "pages" | "items") {
    super(`Vikunja pagination ${limit} limit exceeded for ${path}`);
    this.name = "VikunjaPaginationLimitError";
    this.path = path;
    this.limit = limit;
  }
}

export class VikunjaClient {
  readonly baseUrl: URL;
  readonly perPage: number;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly requestTimeoutMs: number;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #onEvent?: (event: VikunjaClientEvent) => void;
  #lastObserverError?: VikunjaObserverError;

  constructor(options: VikunjaClientOptions) {
    this.baseUrl = apiBaseUrl(options.baseUrl);
    if (!options.token.trim()) throw new Error("Vikunja API token is required");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.perPage = positiveInteger(options.perPage ?? 50, "perPage");
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? 3, "maxRetries");
    this.retryBaseMs = nonNegativeInteger(options.retryBaseMs ?? 250, "retryBaseMs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs");
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  get lastObserverError(): VikunjaObserverError | undefined {
    return this.#lastObserverError;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return jsonResponse<T>(await this.#responseWithRetries(method, path, body));
  }

  async #responseWithRetries(method: string, path: string, body?: unknown): Promise<Response> {
    const normalizedMethod = method.toUpperCase();
    let attempt = 1;
    while (true) {
      try {
        return await this.#requestResponse(normalizedMethod, path, body);
      } catch (error) {
        const retryable = error instanceof VikunjaApiError && isRetryable(error.status);
        const willRetry = normalizedMethod === "GET" && retryable && attempt <= this.maxRetries;
        if (error instanceof VikunjaApiError && error.status === 429) {
          this.#emit(Object.freeze({
            kind: "rate_limit", method: normalizedMethod, path, status: 429, attempt,
            maxRetries: this.maxRetries, retryAfterMs: error.retryAfterMs, willRetry,
          }));
        }
        if (!willRetry || !(error instanceof VikunjaApiError)) throw error;
        const delay = error.retryAfterMs ?? Math.min(30_000, this.retryBaseMs * (2 ** (attempt - 1)));
        this.#emit(Object.freeze({ kind: "request_retry", method: normalizedMethod, path, status: error.status, attempt, delayMs: delay }));
        attempt += 1;
        await this.#delay(delay);
      }
    }
  }

  async paginate<T>(
    path: string,
    parameters: Readonly<Record<string, string | number | boolean | undefined>> = {},
    limits?: VikunjaPaginationLimits,
  ): Promise<readonly T[]> {
    if (limits) validatePaginationLimits(limits);
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      if (limits && page > limits.maxPages) throw new VikunjaPaginationLimitError(path, "pages");
      const query = new URLSearchParams();
      query.set("page", String(page));
      query.set("per_page", String(this.perPage));
      for (const [key, value] of Object.entries(parameters)) if (value !== undefined) query.set(key, String(value));
      const response = await this.#responseWithRetries("GET", `${path}?${query.toString()}`);
      const pageItems = await jsonResponse<T[]>(response);
      if (!Array.isArray(pageItems)) throw new Error(`Vikunja pagination response for ${path} is not an array`);
      items.push(...pageItems);
      if (limits && items.length > limits.maxItems) throw new VikunjaPaginationLimitError(path, "items");
      const totalPages = integerHeader(response.headers.get("x-pagination-total-pages"));
      if (limits && totalPages !== undefined && totalPages > limits.maxPages) throw new VikunjaPaginationLimitError(path, "pages");
      if (totalPages !== undefined ? page >= totalPages : pageItems.length < this.perPage) return items;
    }
  }

  async #requestResponse(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.#fetch(new URL(path.replace(/^\//u, ""), this.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) return response;
      const payload = await safeJson(response);
      const code = numericProperty(payload, "code");
      const detail = stringProperty(payload, "message") ?? stringProperty(payload, "detail") ?? response.statusText;
      throw new VikunjaApiError(`Vikunja ${method} ${path} failed (${response.status}): ${detail}`, response.status, code,
        retryAfterMilliseconds(response.headers.get("retry-after"), this.#now()));
    } catch (error) {
      if (error instanceof VikunjaApiError) throw error;
      if (controller.signal.aborted) throw new VikunjaApiError(`Vikunja ${method} ${path} timed out`, 408);
      throw new VikunjaApiError(`Vikunja ${method} ${path} transport failed`, 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  #emit(event: VikunjaClientEvent): void {
    if (!this.#onEvent) return;
    try {
      this.#onEvent(event);
    } catch (error) {
      this.#lastObserverError = Object.freeze({
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        event,
      });
    }
  }
}

function apiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Vikunja base URL must use http or https");
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/v1/`;
  url.search = "";
  url.hash = "";
  return url;
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
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : undefined;
}

function numericProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function integerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function retryAfterMilliseconds(value: string | null, now: Date = new Date()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/u.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function validatePaginationLimits(limits: VikunjaPaginationLimits): void {
  positiveInteger(limits.maxPages, "maxPages");
  positiveInteger(limits.maxItems, "maxItems");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
