import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { OperationalEvent, OperationalLogRecord } from "../src/domain/observability.ts";
import {
  emitOperational,
  JsonLinesOperationalLogSink,
  StructuredLogger,
} from "../src/observability/logging.ts";
import { VikunjaClient } from "../src/providers/vikunja/client.ts";
import { InMemoryProvider } from "../src/providers/memory/adapter.ts";
import { Scheduler } from "../src/orchestration/scheduler.ts";
import { OrchestratorService } from "../src/orchestration/service.ts";
import { ExecutionEngine } from "../src/execution/engine.ts";
import { RuntimeRegistry } from "../src/runtimes/runtime.ts";
import type { Runtime, RuntimeEvent } from "../src/runtimes/runtime.ts";
import type { RepositoryConfiguration, Task } from "../src/domain/model.ts";

const timestamp = new Date("2026-07-31T12:00:00.000Z");

test("structured logger emits immutable, defensively copied, deterministic records", () => {
  const records: OperationalLogRecord[] = [];
  const data = { status: "running", candidateCount: 3 };
  const logger = new StructuredLogger({
    serviceInstanceId: "instance-1",
    now: () => timestamp,
    sink: { write: (record) => { records.push(record); } },
  });
  logger.emit({ level: "info", event: "scheduler.tick_completed", provider: "vikunja", taskId: "42", data });
  data.status = "changed";

  assert.deepEqual(records[0], {
    timestamp: timestamp.toISOString(), level: "info", event: "scheduler.tick_completed",
    serviceInstanceId: "instance-1", provider: "vikunja", taskId: "42",
    data: { candidateCount: 3, status: "running" },
  });
  assert.ok(Object.isFrozen(records[0]));
  assert.ok(Object.isFrozen(records[0]?.data));
});

test("structured logger enforces the configured minimum level", () => {
  const records: OperationalLogRecord[] = [];
  const logger = new StructuredLogger({
    serviceInstanceId: "instance",
    minimumLevel: "warn",
    sink: { write: (record) => { records.push(record); } },
  });
  logger.emit({ level: "debug", event: "tick.started" });
  logger.emit({ level: "info", event: "tick.completed" });
  logger.emit({ level: "warn", event: "dispatch.failed" });
  logger.emit({ level: "error", event: "tick.failed" });
  assert.deepEqual(records.map((record) => record.level), ["warn", "error"]);
});

test("structured logger bounds Unicode values and fails closed on hostile data", () => {
  const records: OperationalLogRecord[] = [];
  const logger = new StructuredLogger({ serviceInstanceId: "instance", now: () => timestamp,
    redact: (value) => value.replaceAll("known-secret", "[REDACTED]"),
    sink: { write: (record) => { records.push(record); } } });
  const sensitiveFamilies = [
    "authorization", "token", "secret", "password", "credential", "apiKey", "prompt", "error",
    "message", "stack", "result", "providerData", "toolData", "tool_data", "toolDataPayload",
    "payload", "argument", "arguments", "request", "response", "body", "input", "output",
  ] as const;
  const hostile = {
    status: `known-secret-${"😀".repeat(400)}`,
    prompt: "prompt-sentinel",
    unknown: "raw-tool-result-sentinel",
    reason: Object.fromEntries([
      ...sensitiveFamilies.map((key, index) => [key, `nested-sensitive-${index}`]),
      ["nested", "safe"],
    ]),
  } as unknown as OperationalEvent["data"];
  logger.emit({ level: "warn", event: "dispatch.failed", data: hostile });

  const serialized = JSON.stringify(records[0]);
  assert.doesNotMatch(serialized, /known-secret|prompt-sentinel|raw-tool-result-sentinel|nested-sensitive-/u);
  for (const key of sensitiveFamilies) {
    assert.equal(nestedValue(records[0]?.data?.reason, [key]), "[REDACTED]", key);
  }
  assert.match(serialized, /\[TRUNCATED\]|__truncated/u);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 8_192);
  const status = records[0]?.data?.status;
  assert.equal(typeof status, "string");
  assert.ok(!String(status).endsWith("\ud83d"));
});

test("whole-record overflow uses the exact reserved fallback", () => {
  const records: OperationalLogRecord[] = [];
  const logger = new StructuredLogger({ serviceInstanceId: "instance", now: () => timestamp,
    sink: { write: (record) => { records.push(record); } } });
  const keys = ["stage", "status", "reason", "errorCategory", "configurationStatus", "revision",
    "retryAt", "failureKind", "method", "endpoint", "runtimeEventType", "signal",
    "candidateCount", "validatedCount", "dispatchedCount", "workerCount", "remainingCount",
    "cancelledCount", "attempt", "maxRetries", "delayMs", "durationMs", "pollIntervalMs",
    "httpStatus", "retryable", "willRetry", "success", "drained", "restored"];
  const data = Object.fromEntries(keys.map((key) => [key, "x".repeat(500)])) as OperationalEvent["data"];
  logger.emit({ level: "info", event: "tick.completed", provider: "p".repeat(120), repositoryId: "r".repeat(120), data });

  assert.deepEqual(records[0]?.data, { __truncated: true });
  assert.ok(Buffer.byteLength(JSON.stringify(records[0]), "utf8") <= 8_192);
});

test("every structured payload boundary is exact and deterministic", async (context) => {
  const emit = (data: unknown, correlations: Partial<OperationalEvent> = {}): OperationalLogRecord => {
    let record: OperationalLogRecord | undefined;
    new StructuredLogger({ serviceInstanceId: "s".repeat(126), now: () => timestamp,
      sink: { write: (value) => { record = value; } } }).emit({ level: "info", event: "tick.completed",
        ...correlations, data: data as OperationalEvent["data"] });
    return record!;
  };

  await context.test("128-byte correlations retain exact values and truncate overflow without splitting Unicode", () => {
    const exact = "x".repeat(126);
    const record = emit({ status: "ok" }, { provider: exact, repositoryId: exact, taskId: exact, role: exact, executionId: exact });
    for (const value of [record.serviceInstanceId, record.provider, record.repositoryId, record.taskId, record.role, record.executionId]) {
      assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), 128);
    }
    const overflow = emit({ status: "ok" }, { taskId: "😀".repeat(100) }).taskId!;
    assert.ok(Buffer.byteLength(JSON.stringify(overflow), "utf8") <= 128);
    assert.match(overflow, /\[TRUNCATED\]$/u);
  });

  await context.test("512-byte strings retain the edge and truncate the next code point", () => {
    const exact = "x".repeat(510);
    assert.equal(emit({ status: exact }).data?.status, exact);
    const overflow = String(emit({ status: `${exact}x` }).data?.status);
    assert.ok(Buffer.byteLength(JSON.stringify(overflow), "utf8") <= 512);
    assert.match(overflow, /\[TRUNCATED\]$/u);
  });

  await context.test("arrays retain 20 exact items and replace overflow with item 20 marker", () => {
    assert.equal((emit({ reason: Array.from({ length: 20 }, (_, index) => index) }).data?.reason as readonly unknown[]).length, 20);
    assert.deepEqual(emit({ reason: Array.from({ length: 21 }, (_, index) => index) }).data?.reason,
      [...Array.from({ length: 19 }, (_, index) => index), "[TRUNCATED]"]);
  });

  await context.test("mappings retain width 32 or first 31 plus reserved marker", () => {
    const exact = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`k${String(index).padStart(2, "0")}`, index]));
    assert.equal(Object.keys(emit({ reason: exact }).data?.reason as object).length, 32);
    const overflow = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${String(index).padStart(2, "0")}`, index]));
    const result = emit({ reason: overflow }).data?.reason as Record<string, unknown>;
    assert.equal(Object.keys(result).length, 32);
    assert.equal(result.__truncated, true);
    assert.equal(result.k31, undefined);
  });

  await context.test("depth 4 is retained and every value below it becomes the marker", () => {
    assert.equal(nestedValue(emit({ reason: { a: { b: { c: "edge" } } } }).data?.reason, ["a", "b", "c"]), "edge");
    const deep = emit({ reason: { a: { b: { c: { d: "must-not-survive" } } } } });
    assert.equal(nestedValue(deep.data?.reason, ["a", "b", "c", "d"]), "[TRUNCATED]");
    assert.doesNotMatch(JSON.stringify(deep), /must-not-survive/u);
  });

  await context.test("key bytes, collisions, cycles, unsupported values, and non-finite numbers fail closed", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const longKey = "k".repeat(80);
    const collisionPrefix = "a".repeat(80);
    const result = emit({ reason: { ["e".repeat(62)]: "exact", [longKey]: "value", [`${collisionPrefix}a`]: "first",
      [`${collisionPrefix}b`]: "second", cycle, infinity: Infinity, unsupported: Symbol("secret") } }).data?.reason as Record<string, unknown>;
    assert.equal(result.__truncated, true);
    assert.equal(nestedValue(result.cycle, ["self"]), "[TRUNCATED]");
    assert.equal(result.infinity, "[TRUNCATED]");
    assert.equal(result.unsupported, "[TRUNCATED]");
    assert.ok(Object.keys(result).every((key) => Buffer.byteLength(JSON.stringify(key), "utf8") <= 64));
    assert.equal(result["e".repeat(62)], "exact");
    assert.equal(Object.values(result).filter((value) => value === "first").length, 1);
    assert.equal(Object.values(result).includes("second"), false);
  });
});

test("redactor, reporter, and sink failures never escape", async () => {
  const suppressed: OperationalLogRecord[] = [];
  const logger = new StructuredLogger({ serviceInstanceId: "instance", now: () => timestamp,
    redact: () => { throw new Error("secret-redactor-message"); },
    sink: { write: (record) => { suppressed.push(record); } } });
  assert.doesNotThrow(() => logger.emit({ level: "info", event: "tick.completed", taskId: "secret" }));
  assert.equal(suppressed[0]?.event, "observability.record_suppressed");

  const failing = new StructuredLogger({ serviceInstanceId: "instance", now: () => timestamp,
    sink: { write: () => { throw new Error("sink-secret"); } } });
  assert.doesNotThrow(() => failing.emit({ level: "info", event: "tick.completed" }));
  assert.equal(failing.sinkFailureCount, 1);
  assert.doesNotThrow(() => emitOperational({ emit: () => { throw new Error("observer-secret"); } },
    { level: "info", event: "tick.completed" }));
  emitOperational({ emit: () => Promise.reject(new Error("rejected-secret")) }, { level: "info", event: "tick.completed" });
  await Promise.resolve();
});

test("JSON-lines sink writes one JSON record per line", () => {
  const chunks: string[] = [];
  const sink = new JsonLinesOperationalLogSink({ write: (chunk) => { chunks.push(chunk); } });
  const logger = new StructuredLogger({ serviceInstanceId: "instance", now: () => timestamp, sink });
  logger.emit({ level: "info", event: "service.running" });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.endsWith("\n"), true);
  assert.equal(JSON.parse(chunks[0]!).event, "service.running");
});

test("Vikunja operational retry projection excludes token, URL data, and response payloads", async () => {
  const events: OperationalEvent[] = [];
  let calls = 0;
  const client = new VikunjaClient({
    baseUrl: "https://vikunja.example", token: "token-sentinel", repositoryId: "ensemble",
    maxRetries: 1, retryBaseMs: 0, delay: async () => undefined,
    operationalEvents: { emit: (event) => { events.push(event); } },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ message: "response-secret" }), { status: 503 });
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });
  await client.request("GET", "projects/10/views/20/tasks?filter=tool-secret");
  assert.deepEqual(events, [{ level: "warn", event: "provider.request_retry", provider: "vikunja",
    repositoryId: "ensemble", data: { method: "GET", endpoint: "project_views", httpStatus: 503,
      attempt: 1, delayMs: 0, willRetry: true } }]);
  assert.doesNotMatch(JSON.stringify(events), /token-sentinel|response-secret|tool-secret/u);
});

test("components do not call operational reporters directly", async () => {
  const files = ["src/orchestration/service.ts", "src/orchestration/scheduler.ts", "src/execution/engine.ts",
    "src/providers/vikunja/client.ts"];
  for (const file of files) assert.doesNotMatch(await readFile(file, "utf8"), /\.emit\s*\(/u, file);
});

test("throwing and rejecting operational reporters cannot change component outcomes", async () => {
  const throwing = { emit: () => { throw new Error("observer-secret"); } };
  const rejecting = { emit: () => Promise.reject(new Error("observer-secret")) };
  const executions = {
    reloadConfiguration: async () => { throw new Error("unused"); },
    withConfiguration: async <T>() => { throw new Error("unexpected configuration"); return undefined as T; },
  };
  const schedulerEvents: OperationalEvent[] = [];
  const scheduler = new Scheduler(new InMemoryProvider([]), executions, { events: { emit: (event) => {
    schedulerEvents.push(event); throw new Error("observer-secret");
  } } });
  assert.deepEqual(await scheduler.startup(), { validatedTaskIds: [] });
  assert.deepEqual(await scheduler.tick(), { dispatchedTaskIds: [] });
  assert.equal((await scheduler.shutdown({ drainTimeoutMs: 0, cancellationTimeoutMs: 0 })).drained, true);
  for (const event of ["scheduler.startup_started", "scheduler.startup_completed", "scheduler.tick_started",
    "reconciliation.started", "reconciliation.completed", "scheduler.tick_completed", "scheduler.shutdown_started",
    "scheduler.shutdown_completed"] as const) assert.ok(schedulerEvents.some((item) => item.event === event), event);

  const serviceScheduler = {
    reloadConfiguration: async () => ({ status: "unchanged" as const, revision: "revision-1",
      operationalPolicy: { startupTimeoutMs: 30_000, pollIntervalMs: 1, drainTimeoutMs: 1,
        cancellationTimeoutMs: 1 } }),
    startup: async () => ({ validatedTaskIds: [] }),
    tick: async () => ({ dispatchedTaskIds: [] }),
    shutdown: async () => ({ drained: true, cancelledTaskIds: [], remainingTaskIds: [] }),
  };
  const signals = { addListener: () => undefined, removeListener: () => undefined };
  const timers = { set: () => 1, clear: () => undefined };
  const serviceEvents: OperationalEvent[] = [];
  const service = new OrchestratorService([{ id: "repo", scheduler: serviceScheduler, startupTimeoutMs: 30_000,
    pollIntervalMs: 1,
    drainTimeoutMs: 1, cancellationTimeoutMs: 1 }], signals, timers, { emit: (event) => {
      serviceEvents.push(event); return Promise.reject(new Error("observer-secret"));
    } });
  const started = service.start();
  await new Promise((resolve) => setImmediate(resolve));
  await service.shutdown();
  await started;
  for (const event of ["service.starting", "repository.startup_started", "configuration.reload_started",
    "configuration.reload_unchanged", "repository.startup_succeeded", "service.running", "tick.started",
    "tick.completed", "service.timer_scheduled", "service.shutdown_started", "repository.shutdown_completed",
    "service.shutdown_completed"] as const) assert.ok(serviceEvents.some((item) => item.event === event), event);
  assert.ok(serviceEvents.filter((event) => event.event.startsWith("repository.") || event.event.startsWith("tick.")
    || event.event.startsWith("configuration.")).every((event) => event.repositoryId === "repo"));

  const task: Task = { id: "task", title: "t", description: "", acceptanceCriteria: [], status: "ready",
    labels: [], assignees: [], repository: { id: "repo", url: "https://example.test/repo.git" } };
  const configuration = { repository: task.repository } as RepositoryConfiguration;
  const engine = new ExecutionEngine(new RuntimeRegistry(), {
    restore: async () => undefined,
    create: async () => { throw new Error("unused"); },
    cleanup: async () => undefined,
  }, { resolve: async () => configuration }, undefined, 1, () => timestamp.toISOString(), throwing);
  await engine.withConfiguration(task, async () => undefined);

  const client = new VikunjaClient({ baseUrl: "https://vikunja.example", token: "token", maxRetries: 1,
    retryBaseMs: 0, delay: async () => undefined, operationalEvents: rejecting,
    fetch: async () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }) });
  await assert.rejects(client.request("POST", "tasks", {}));
});

test("Service failure lifecycle events are stable, correlated, and payload-free", async () => {
  const events: OperationalEvent[] = [];
  let reloads = 0;
  const scheduler = {
    reloadConfiguration: async () => {
      reloads += 1;
      if (reloads > 1) throw new Error("configuration-secret");
      return { status: "installed" as const, revision: "r1",
        operationalPolicy: { startupTimeoutMs: 30_000, pollIntervalMs: 1, drainTimeoutMs: 1,
          cancellationTimeoutMs: 1 } };
    },
    startup: async () => ({ validatedTaskIds: [] }), tick: async () => ({ dispatchedTaskIds: [] }),
    shutdown: async () => { throw new Error("shutdown-secret"); },
  };
  const service = new OrchestratorService([{ id: "repo", scheduler, startupTimeoutMs: 30_000,
    pollIntervalMs: 1, drainTimeoutMs: 1,
    cancellationTimeoutMs: 1 }], { addListener: () => undefined, removeListener: () => undefined },
  { set: () => 1, clear: () => undefined }, { emit: (event) => { events.push(event); } });
  const started = service.start();
  await new Promise((resolve) => setImmediate(resolve));
  await service.shutdown();
  await started;
  for (const name of ["configuration.reload_failed", "tick.failed", "repository.shutdown_failed"] as const) {
    const event = events.find((candidate) => candidate.event === name);
    assert.equal(event?.repositoryId, "repo");
    assert.ok(event?.data?.errorCategory);
  }
  assert.doesNotMatch(JSON.stringify(events), /configuration-secret|shutdown-secret/u);
});

test("ExecutionEngine projects every runtime payload variant without raw data and preserves primary failures", async () => {
  const observed: OperationalEvent[] = [];
  const task: Task = { id: "task", title: "title-secret", description: "prompt-secret", acceptanceCriteria: [],
    status: "ready", labels: [], assignees: [], repository: { id: "repo", url: "https://secret.example/repo.git" } };
  const events: RuntimeEvent[] = [
    { type: "run_started", at: timestamp.toISOString(), sessionId: "session-secret" },
    { type: "progress_updated", at: timestamp.toISOString(), message: "progress-secret", percent: 50 },
    { type: "tool_started", at: timestamp.toISOString(), tool: "tool-secret" },
    { type: "tool_finished", at: timestamp.toISOString(), tool: "tool-secret", success: true },
    { type: "validation_started", at: timestamp.toISOString(), name: "validation-secret" },
    { type: "validation_finished", at: timestamp.toISOString(), name: "validation-secret", success: false },
    { type: "artifact_created", at: timestamp.toISOString(), artifact: { type: "secret", url: "https://artifact-secret" } },
    { type: "comment_requested", at: timestamp.toISOString(), body: "comment-secret" },
    { type: "next_agent_requested", at: timestamp.toISOString(), role: "role-secret" },
    { type: "run_failed", at: timestamp.toISOString(), error: "runtime-error-secret" },
  ];
  const runtime: Runtime = {
    name: "safe",
    prepare: async (context) => ({ id: "prepared", context, payload: undefined }),
    start: async () => ({ id: "session", events: (async function* () { for (const event of events) yield event; })(),
      result: Promise.resolve({ outcome: "completed", summary: "summary-secret", comments: [], artifacts: [] }) }),
    resume: async () => { throw new Error("unused"); }, cancel: async () => undefined,
  };
  const configuration = { repository: task.repository, runtime: { name: "safe", config: {} },
    timeouts: { cancellationMs: 1 }, workflow: { instructions: "workflow-secret", roles: [{ name: "implementation", instructions: "role-instructions-secret" }] },
    agents: "agents-secret" } as unknown as RepositoryConfiguration;
  const engine = new ExecutionEngine(new RuntimeRegistry([runtime]), {
    restore: async () => ({ root: "/workspace-secret", repositoryPath: "/repository-secret", runtimePath: "/runtime-secret" }),
    create: async () => { throw new Error("unused"); }, cleanup: async () => undefined,
  }, { resolve: async () => configuration }, undefined, 1, () => timestamp.toISOString(),
  { emit: (event) => { observed.push(event); } });
  const running = await engine.withConfiguration(task, (configured) => configured.withEnvironment((environment) => environment.start({
    task, role: { name: "implementation", instructions: "role-secret" }, comments: [], artifacts: [], executionId: "execution",
  })));
  await running.result;
  const serialized = JSON.stringify(observed);
  for (const secret of ["title-secret", "prompt-secret", "session-secret", "progress-secret", "tool-secret", "validation-secret",
    "artifact-secret", "comment-secret", "role-secret", "runtime-error-secret", "summary-secret", "workflow-secret", "agents-secret",
    "workspace-secret", "repository-secret", "runtime-secret"]) assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.equal(observed.filter((event) => event.event === "runtime.event").length, events.length);

  const primary = new Error("primary-runtime-error");
  const failingRuntime: Runtime = { ...runtime, name: "failing", start: async () => ({ id: "failed-session",
    events: (async function* () {})(), result: Promise.reject(primary) }) };
  const failingConfiguration = { ...configuration, runtime: { name: "failing", config: {} } } as RepositoryConfiguration;
  const failingEngine = new ExecutionEngine(new RuntimeRegistry([failingRuntime]), {
    restore: async () => ({ root: "/w", repositoryPath: "/r", runtimePath: "/x" }),
    create: async () => { throw new Error("unused"); }, cleanup: async () => { throw new Error("secondary-cleanup-secret"); },
  }, { resolve: async () => failingConfiguration }, undefined, 1, () => timestamp.toISOString(), { emit: () => { throw new Error("observer-secret"); } });
  const failed = await failingEngine.withConfiguration(task, (configured) => configured.withEnvironment((environment) => environment.start({
    task, role: { name: "implementation", instructions: "" }, comments: [], artifacts: [], executionId: "failed",
  })));
  await assert.rejects(failed.result, (error) => error === primary);
});

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  return current;
}
