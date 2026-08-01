import type {
  OperationalDataValue,
  OperationalEvent,
  OperationalEventReporter,
  OperationalLogLevel,
  OperationalLogRecord,
  OperationalLogSink,
} from "../domain/observability.ts";
import { OPERATIONAL_EVENT_NAMES } from "../domain/observability.ts";

const MARKER = "[TRUNCATED]";
const REDACTED = "[REDACTED]";
const MAX_RECORD_BYTES = 8_192;
const EVENT_NAMES = new Set<string>(OPERATIONAL_EVENT_NAMES);
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const ALLOWED_DATA_KEYS = new Set([
  "stage", "status", "reason", "errorCategory", "configurationStatus", "revision",
  "candidateCount", "validatedCount", "dispatchedCount", "workerCount", "remainingCount",
  "cancelledCount", "failureKind", "retryAt", "retryable", "attempt", "maxRetries",
  "delayMs", "durationMs", "pollIntervalMs", "willRetry", "httpStatus", "method",
  "endpoint", "runtimeEventType", "success", "drained", "restored", "signal",
]);
const SENSITIVE_KEY = /(token|secret|authori[sz]ation|password|credential|api.?key|prompt|error|message|stack|result|provider.?data|tool.?data|payload|arguments?|request|response|body|input|output)/iu;

export interface StructuredLoggerOptions {
  readonly serviceInstanceId: string;
  readonly sink: OperationalLogSink;
  readonly now?: () => Date;
  readonly redact?: (value: string) => string;
  readonly minimumLevel?: OperationalLogLevel;
}

export const noopOperationalReporter: OperationalEventReporter = Object.freeze({ emit: () => undefined });

export function emitOperational(reporter: OperationalEventReporter | undefined, event: OperationalEvent): void {
  if (!reporter) return;
  try {
    void Promise.resolve(reporter.emit(event)).catch(() => undefined);
  } catch {
    // Observability is best-effort and never changes orchestration outcomes.
  }
}

export class StructuredLogger implements OperationalEventReporter {
  readonly #serviceInstanceId: string;
  readonly #sink: OperationalLogSink;
  readonly #now: () => Date;
  readonly #redact: (value: string) => string;
  readonly #minimumLevel: OperationalLogLevel;
  #sinkFailures = 0;

  constructor(options: StructuredLoggerOptions) {
    this.#serviceInstanceId = boundedString(requireText(options.serviceInstanceId), 128);
    this.#sink = options.sink;
    this.#now = options.now ?? (() => new Date());
    this.#redact = options.redact ?? ((value) => value);
    this.#minimumLevel = options.minimumLevel ?? "debug";
  }

  get sinkFailureCount(): number { return this.#sinkFailures; }

  emit(event: OperationalEvent): void {
    if (levelRank(event.level) < levelRank(this.#minimumLevel)) return;
    let record: OperationalLogRecord;
    try {
      record = this.#record(event);
    } catch {
      try { record = this.#record({ level: "error", event: "observability.record_suppressed" }); }
      catch { return; }
    }
    try {
      void Promise.resolve(this.#sink.write(record)).catch(() => { this.#sinkFailures = increment(this.#sinkFailures); });
    } catch {
      this.#sinkFailures = increment(this.#sinkFailures);
    }
  }

  #record(event: OperationalEvent): OperationalLogRecord {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid observability clock");
    if (!LEVELS.has(event.level) || !EVENT_NAMES.has(event.event)
      || !/^[a-z]+(?:[._][a-z]+)*$/u.test(event.event) || jsonBytes(event.event) > 96) throw new Error("Invalid event");
    const base = {
      timestamp: now.toISOString(),
      level: event.level,
      event: event.event,
      serviceInstanceId: this.#serviceInstanceId,
      ...optionalString("provider", event.provider, this.#redact),
      ...optionalString("repositoryId", event.repositoryId, this.#redact),
      ...optionalString("taskId", event.taskId, this.#redact),
      ...optionalString("role", event.role, this.#redact),
      ...optionalString("executionId", event.executionId, this.#redact),
    };
    let record: OperationalLogRecord = { ...base, ...(event.data ? { data: sanitizeMapping(event.data, 0, this.#redact) } : {}) };
    if (jsonBytes(record) > MAX_RECORD_BYTES) record = { ...base, data: { __truncated: true } };
    if (jsonBytes(record) > MAX_RECORD_BYTES) throw new Error("Record invariant failed");
    return deepFreeze(record);
  }
}

function levelRank(level: OperationalLogLevel): number {
  return level === "debug" ? 0 : level === "info" ? 1 : level === "warn" ? 2 : 3;
}

export interface JsonLinesWritable { write(chunk: string): unknown; }

export class JsonLinesOperationalLogSink implements OperationalLogSink {
  readonly #writable: JsonLinesWritable;
  constructor(writable: JsonLinesWritable) { this.#writable = writable; }
  write(record: OperationalLogRecord): void { this.#writable.write(`${JSON.stringify(record)}\n`); }
}

function sanitizeMapping(input: Readonly<Record<string, OperationalDataValue>>, depth: number, redact: (value: string) => string): Readonly<Record<string, OperationalDataValue>> {
  const output: Record<string, OperationalDataValue> = {};
  let truncated = false;
  const keys = Object.keys(input).sort();
  for (const original of keys) {
    if (original === "__truncated" || !ALLOWED_DATA_KEYS.has(original)) { truncated = true; continue; }
    if (Object.keys(output).length >= 31 && keys.length > 32) { truncated = true; break; }
    const key = boundedString(original, 64);
    truncated ||= key !== original;
    if (Object.hasOwn(output, key)) { truncated = true; continue; }
    const sanitized = sanitizeValue(input[original], depth + 1, redact, new Set<object>());
    output[key] = sanitized.value;
    truncated ||= sanitized.truncated;
  }
  reserveTruncationMarker(output, truncated);
  return output;
}

function sanitizeValue(value: unknown, depth: number, redact: (value: string) => string, seen: Set<object>): { value: OperationalDataValue; truncated: boolean } {
  if (depth > 4) return { value: MARKER, truncated: true };
  if (value === null || typeof value === "boolean") return { value, truncated: false };
  if (typeof value === "number") return Number.isFinite(value) ? { value, truncated: false } : { value: MARKER, truncated: true };
  if (typeof value === "string") {
    const redacted = redact(value);
    const bounded = boundedString(redacted, 512);
    return { value: bounded, truncated: bounded !== value };
  }
  if (!value || typeof value !== "object" || seen.has(value)) return { value: MARKER, truncated: true };
  seen.add(value);
  if (Array.isArray(value)) {
    const output: OperationalDataValue[] = [];
    let truncated = value.length > 20;
    const limit = value.length > 20 ? 19 : value.length;
    for (let index = 0; index < limit; index += 1) {
      const item = sanitizeValue(value[index], depth + 1, redact, seen);
      output.push(item.value); truncated ||= item.truncated;
    }
    if (value.length > 20) output.push(MARKER);
    seen.delete(value);
    return { value: output, truncated };
  }
  const output: Record<string, OperationalDataValue> = {};
  let truncated = false;
  const keys = Object.keys(value).sort();
  for (const original of keys) {
    if (original === "__truncated") { truncated = true; continue; }
    if (Object.keys(output).length >= 31 && keys.length > 32) { truncated = true; break; }
    const key = boundedString(original, 64);
    truncated ||= key !== original;
    if (Object.hasOwn(output, key)) { truncated = true; continue; }
    if (SENSITIVE_KEY.test(original)) { output[key] = REDACTED; truncated = true; continue; }
    const item = sanitizeValue((value as Record<string, unknown>)[original], depth + 1, redact, seen);
    output[key] = item.value; truncated ||= item.truncated;
  }
  reserveTruncationMarker(output, truncated);
  seen.delete(value);
  return { value: output, truncated };
}

function optionalString<K extends string>(key: K, value: string | undefined, redact: (value: string) => string): { [P in K]?: string } {
  if (value === undefined || value.length === 0) return {};
  const sanitized = boundedString(redact(value), 128);
  return sanitized.length === 0 ? {} : { [key]: sanitized } as { [P in K]?: string };
}

function reserveTruncationMarker(output: Record<string, OperationalDataValue>, truncated: boolean): void {
  if (!truncated) return;
  const keys = Object.keys(output).sort();
  for (const key of keys.slice(31)) delete output[key];
  output.__truncated = true;
}

function boundedString(value: string, maximumBytes: number): string {
  if (jsonBytes(value) <= maximumBytes) return value;
  let output = "";
  for (const character of value) {
    if (jsonBytes(output + character + MARKER) > maximumBytes) break;
    output += character;
  }
  return output + MARKER;
}

function requireText(value: string): string {
  if (!value.trim()) throw new Error("Service instance ID is required");
  return value;
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function increment(value: number): number { return value < Number.MAX_SAFE_INTEGER ? value + 1 : value; }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
