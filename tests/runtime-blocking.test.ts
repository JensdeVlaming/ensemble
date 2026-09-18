import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { leaseClaim, leaseGuard } from "./lease-helpers.ts";
import {
  CodexContextBuilder,
  ExecutionEngine,
  InMemoryProvider,
  RepositoryConfigLoader,
  RuntimeRegistry,
  Scheduler,
  ScriptedRuntime,
  WorkspaceConfigurationResolver,
  validateRuntimeTools,
} from "../src/index.ts";
import type {
  PortableJsonValue,
  ProviderAdapter,
  RepositoryRef,
  Runtime,
  RuntimeEvent,
  RuntimeResult,
  RuntimeTool,
  Task,
  Workspace,
  WorkspaceManager,
} from "../src/index.ts";

const repository: RepositoryRef = { id: "blocking", url: "local://blocking" };

function task(status = "ready"): Task {
  return { id: "42", title: "Operator request", description: "Wait safely", acceptanceCriteria: [],
    status, labels: [], assignees: [], dispatchable: true, repository };
}

async function fixture(operatorRequests: string | null = "block"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-blocking-"));
  await mkdir(join(root, ".ensemble", "roles"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Keep credentials private.");
  await writeFile(join(root, ".ensemble", "WORKFLOW.md"), "Return structured results.");
  await writeFile(join(root, ".ensemble", "roles", "implementation.md"), "Implement.");
  await writeFile(join(root, ".ensemble", "config.yaml"), [
    "runtime:", "  name: controlled",
    ...(operatorRequests === null ? [] : ["  config:", `    operatorRequests: ${operatorRequests}`]),
    "initialRole: implementation", "terminalOutcomes: [approved]",
    "statuses:", "  runnable: [ready, running, blocked]", "  running: running", "  completed: completed",
    "  failed: failed", "  blocked: blocked", "timeouts:", "  cancellationMs: 0",
    "retry:", "  initialDelayMs: 0", "  maxDelayMs: 0",
  ].join("\n"));
  return root;
}

class FixedWorkspaces implements WorkspaceManager {
  cleaned = 0;
  validated = 0;
  validationError?: Error;
  readonly repositoryPath: string;
  constructor(repositoryPath: string) { this.repositoryPath = repositoryPath; }
  async create(item: Task): Promise<Workspace> {
    return { root: `/blocking/${item.id}`, repositoryPath: this.repositoryPath, runtimePath: `/blocking/${item.id}/runtime` };
  }
  async restore(): Promise<Workspace | undefined> { return undefined; }
  async validate(): Promise<void> { this.validated += 1; if (this.validationError) throw this.validationError; }
  async cleanup(): Promise<void> { this.cleaned += 1; }
}

function blockingRuntime(onCancel: () => void = () => undefined): Runtime {
  return {
    name: "controlled",
    validateConfiguration: (config) => {
      if (config.operatorRequests !== "block") throw new Error("Blocking runtime requires operatorRequests: block");
    },
    prepare: async (context) => ({ id: "prepared", context, payload: null, operatorRequests: "block" }),
    start: async (prepared) => ({
      id: "runtime-thread",
      events: (async function* (): AsyncIterable<RuntimeEvent> {
        yield {
          type: "approval_requested",
          executionId: prepared.context.executionId,
          at: "2026-08-01T10:00:00.000Z",
          request: { kind: "approval", summary: "Approve repository write", requestId: "approval-1",
            createdAt: "2026-08-01T10:00:00.000Z" },
        };
        await new Promise(() => undefined);
      })(),
      result: new Promise<RuntimeResult>(() => undefined),
    }),
    resume: async (session) => session,
    cancel: async () => { onCancel(); },
  };
}

function engine(root: string, runtime: Runtime, workspaces = new FixedWorkspaces(root)): ExecutionEngine {
  return new ExecutionEngine(new RuntimeRegistry([runtime]), workspaces,
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root), undefined, 0);
}

const at = "2026-08-01T10:00:00.000Z";
const executionId = "event-execution";
const approved: RuntimeResult = { outcome: "approved", summary: "Done", comments: [], artifacts: [] };

test("ExecutionEngine revalidates workspace containment immediately before runtime preparation", async () => {
  const root = await fixture();
  const workspaces = new FixedWorkspaces(root);
  workspaces.validationError = new Error("workspace boundary changed");
  let prepared = false;
  const runtime: Runtime = {
    name: "controlled",
    validateConfiguration: () => undefined,
    prepare: async (context) => { prepared = true; return { id: "prepared", context, payload: null }; },
    start: async () => { throw new Error("must not start"); },
    resume: async (session) => session,
    cancel: async () => undefined,
  };
  const service = engine(root, runtime, workspaces);
  await assert.rejects(service.withEnvironment(task(), (environment) => environment.start({
    task: task(), role: { name: "implementation", instructions: "" }, comments: [], artifacts: [], executionId,
  })), /workspace boundary changed/u);
  assert.equal(workspaces.validated, 1);
  assert.equal(prepared, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workspaces.cleaned, 1);
});

function request(id = "approval-1") {
  return { kind: "approval" as const, summary: "Approve repository write", requestId: id, createdAt: at };
}

function eventRuntime(options: {
  readonly events: () => AsyncIterable<RuntimeEvent>;
  readonly result?: Promise<RuntimeResult>;
  readonly cancel?: () => Promise<void>;
}): Runtime {
  return {
    name: "controlled",
    validateConfiguration: () => undefined,
    prepare: async (context) => ({ id: "prepared", context, payload: null, operatorRequests: "block" }),
    start: async () => ({ id: "session", events: options.events(),
      result: options.result ?? new Promise<RuntimeResult>(() => undefined) }),
    resume: async (session) => session,
    cancel: options.cancel ?? (async () => undefined),
  };
}

async function start(root: string, runtime: Runtime, events?: (event: RuntimeEvent) => void | Promise<void>) {
  const item = task();
  const service = events === undefined ? engine(root, runtime) : new ExecutionEngine(
    new RuntimeRegistry([runtime]), new FixedWorkspaces(root),
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root), events, 0,
  );
  return service.withEnvironment(item, (environment) => environment.start({
    task: item, role: { name: "implementation", instructions: "" }, comments: [], artifacts: [], executionId,
  }));
}

test("portable tools are immutable, bounded, result-validated, and prompt serialization omits capabilities", async () => {
  const invoked: unknown[] = [];
  const invocationSignals: Array<AbortSignal | undefined> = [];
  const secret = "provider-token-sentinel";
  const returned = { title: "safe" };
  const tool: RuntimeTool = {
    name: "task_read",
    description: "Read the current task",
    inputSchema: { type: "object", properties: { includeComments: { type: "boolean" } }, additionalProperties: false },
    invoke: async (input, context) => { invoked.push(input); invocationSignals.push(context?.signal); void secret; return returned; },
  };
  const [validated] = validateRuntimeTools([tool]);
  assert.ok(validated);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.inputSchema), true);
  const invocation = new AbortController();
  const toolResult = await validated.invoke({ includeComments: true }, { signal: invocation.signal });
  assert.deepEqual(toolResult, { title: "safe" });
  assert.equal(Object.isFrozen(toolResult), true);
  returned.title = "changed-after-validation";
  assert.deepEqual(toolResult, { title: "safe" });
  assert.deepEqual(invoked, [{ includeComments: true }]);
  assert.deepEqual(invocationSignals, [invocation.signal]);
  await assert.rejects(validated.invoke({ includeComments: "yes" }), /does not match its schema/u);
  assert.equal(invoked.length, 1);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const invalidResult: RuntimeTool = { ...tool, name: "task_invalid", invoke: async () => cyclic as PortableJsonValue };
  await assert.rejects(validateRuntimeTools([invalidResult])[0]!.invoke({}), /acyclic JSON/u);
  assert.throws(() => validateRuntimeTools([{ ...tool, inputSchema: { type: "array" } }]), /array schema requires items/u);
  assert.throws(() => validateRuntimeTools([{ ...tool, inputSchema: { type: "object", minimum: 1 } as never }]), /Unsupported/u);
  assert.throws(() => validateRuntimeTools([{ ...tool, inputSchema: { type: "object", properties: {
    value: { type: "string", enum: [1] },
  } } as never }]), /does not match its schema/u);
  assert.throws(() => validateRuntimeTools([tool, tool]), /Duplicate runtime tool/u);
  assert.throws(() => validateRuntimeTools([{ ...tool, name: "task.read" }]), /Invalid runtime tool name/u);
  assert.throws(() => validateRuntimeTools(Array.from({ length: 65 }, (_value, index) => ({ ...tool, name: `task_t${index}` }))), /64 tools/u);
  const largeEnum = Array.from({ length: 60 }, (_value, index) => `${index}-${"x".repeat(700)}`);
  assert.throws(() => validateRuntimeTools(Array.from({ length: 7 }, (_value, index) => ({ ...tool, name: `task_large${index}`,
    inputSchema: { type: "object", properties: { value: { type: "string", enum: largeEnum } } } }))), /aggregate size/u);
  const manyProperties = Object.fromEntries(Array.from({ length: 1_000 }, (_value, index) => [`p${index}`, { type: "boolean" }]));
  assert.throws(() => validateRuntimeTools(Array.from({ length: 6 }, (_value, index) => ({ ...tool, name: `task_nodes${index}`,
    inputSchema: { type: "object", properties: manyProperties } }))), /node count/u);

  const context = new CodexContextBuilder().build({
    executionId: "execution-1", repository, workspace: { root: "/w", repositoryPath: "/w/repository", runtimePath: "/w/runtime" },
    task: task(), comments: [], artifacts: [], workflow: { instructions: "Work", roles: [] }, agents: "Rules",
    role: { name: "implementation", instructions: "Implement" }, runtimeConfig: {}, tools: [validated],
  });
  const serialized = JSON.stringify(context);
  assert.match(serialized, /task_read/u);
  assert.doesNotMatch(serialized, /provider-token-sentinel|invoke/u);
});

test("a blocking event settles the live handle through bounded cancellation", async () => {
  const root = await fixture();
  const spaces = new FixedWorkspaces(root);
  let cancellations = 0;
  const execution = engine(root, blockingRuntime(() => { cancellations += 1; }), spaces);
  const item = task();
  const running = await execution.withEnvironment(item, (environment) => environment.start({
    task: item, role: { name: "implementation", instructions: "Implement" }, comments: [], artifacts: [], executionId: "execution-1",
  }));
  const report = await running.result;
  assert.equal(report.kind, "blocked");
  assert.equal(report.blockingRequest?.kind, "approval");
  assert.equal(cancellations, 1);
  assert.equal(spaces.cleaned, 1);
  assert.equal(running.snapshot().state, "blocked");
  assert.equal(running.snapshot().cancellationReason, "operator");
});

test("runtime events cannot substitute a session identity for the provider execution ID", async () => {
  const root = await fixture();
  let cancelled = false;
  const runtime: Runtime = {
    name: "controlled",
    prepare: async (context) => ({ id: "prepared", context, payload: null }),
    start: async () => ({ id: "thread-id", events: (async function* (): AsyncIterable<RuntimeEvent> {
      yield { type: "heartbeat", at: "2026-08-01T10:00:00.000Z", executionId: "thread-id" };
    })(), result: new Promise<RuntimeResult>(() => undefined) }),
    resume: async (session) => session,
    cancel: async () => { cancelled = true; },
  };
  const item = task();
  const running = await engine(root, runtime).withEnvironment(item, (environment) => environment.start({
    task: item, role: { name: "implementation", instructions: "" }, comments: [], artifacts: [], executionId: "provider-execution",
  }));
  await assert.rejects(running.result, /execution ID mismatch/u);
  assert.equal(cancelled, true);
});

test("blocking timestamps are canonicalized before they cross the provider boundary", async () => {
  const root = await fixture();
  const runtime = eventRuntime({ events: () => (async function* () {
    yield { type: "approval_requested", at, executionId,
      request: { ...request(), createdAt: "2026-08-01T12:00:00+02:00" } };
  })() });
  const report = await (await start(root, runtime)).result;
  assert.equal(report.kind, "blocked");
  if (report.kind === "blocked") assert.equal(report.blockingRequest.createdAt, at);
});

test("every runtime event family rejects undeclared data without echoing it", async () => {
  const root = await fixture();
  const base = { at, executionId };
  const events: readonly Record<string, unknown>[] = [
    { ...base, type: "run_started", sessionId: "session" },
    { ...base, type: "progress_updated", message: "working", percent: 10 },
    { ...base, type: "tool_started", tool: "read" },
    { ...base, type: "tool_finished", tool: "read", success: true },
    { ...base, type: "validation_started", name: "tests" },
    { ...base, type: "validation_finished", name: "tests", success: true },
    { ...base, type: "artifact_created", artifact: { type: "link", url: "https://example.test" } },
    { ...base, type: "comment_requested", body: "Ready" },
    { ...base, type: "next_agent_requested", role: "review" },
    { ...base, type: "run_completed", result: approved },
    { ...base, type: "run_failed", error: "failed" },
    { ...base, type: "approval_requested", request: request() },
    { ...base, type: "user_input_requested", request: { ...request(), kind: "user_input" } },
    { ...base, type: "tool_elicitation_requested", request: { ...request(), kind: "tool_elicitation" } },
    { ...base, type: "usage_updated", inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    { ...base, type: "rate_limit_updated", limitId: "primary", usedPercent: 25, resetsAt: at },
    { ...base, type: "heartbeat" },
  ];
  for (const candidate of events) {
    const raw = { ...candidate, providerCredential: "secret-event-sentinel" } as unknown as RuntimeEvent;
    const running = await start(root, eventRuntime({ events: () => (async function* () { yield raw; })() }));
    await assert.rejects(running.result, (error: unknown) => {
      assert.match(String(error), /undeclared fields/u);
      assert.doesNotMatch(String(error), /secret-event-sentinel/u);
      return true;
    });
  }
});

test("runtime event and result boundaries reject unsupported, oversized, and nested secret-bearing records", async () => {
  const root = await fixture();
  const invalid: readonly RuntimeEvent[] = [
    { type: "unknown", at, executionId } as unknown as RuntimeEvent,
    { type: "run_started", at, executionId, sessionId: "x".repeat(257) },
    { type: "artifact_created", at, executionId,
      artifact: { type: "link", url: "https://example.test", metadata: ["invalid"] } as never },
    { type: "approval_requested", at, executionId,
      request: { ...request(), providerCredential: "nested-secret-sentinel" } as never },
  ];
  for (const raw of invalid) {
    const running = await start(root, eventRuntime({ events: () => (async function* () { yield raw; })() }));
    await assert.rejects(running.result, (error: unknown) => {
      assert.doesNotMatch(String(error), /nested-secret-sentinel/u);
      return true;
    });
  }
  const malformed = Promise.resolve({ ...approved,
    artifacts: [{ type: "link", url: "https://example.test", metadata: ["invalid"] }] } as unknown as RuntimeResult);
  const running = await start(root, eventRuntime({ events: () => (async function* () {})(), result: malformed }));
  await assert.rejects(running.result, /artifact metadata is invalid/u);
});

test("blocking wins after an early result and before a slow or failing event sink", async () => {
  const root = await fixture();
  for (const sink of [async () => new Promise<void>(() => undefined), async () => { throw new Error("sink failed"); }]) {
    const runtime = eventRuntime({
      events: () => (async function* () {
        yield { type: "approval_requested", at, executionId, request: request() };
        await new Promise(() => undefined);
      })(),
      result: Promise.resolve(approved),
    });
    const running = await start(root, runtime, sink);
    assert.equal((await running.result).kind, "blocked");
  }
});

test("the first blocking request is stable and cancellation is bounded when runtime cancellation rejects or hangs", async () => {
  const root = await fixture();
  for (const cancel of [async () => { throw new Error("cancel failed"); }, async () => new Promise<void>(() => undefined)]) {
    const runtime = eventRuntime({ events: () => (async function* () {
      yield { type: "approval_requested", at, executionId, request: request("first") };
      yield { type: "approval_requested", at, executionId, request: request("second") };
      await new Promise(() => undefined);
    })(), cancel });
    const running = await start(root, runtime);
    const report = await running.result;
    assert.equal(report.kind, "blocked");
    if (report.kind === "blocked") assert.equal(report.blockingRequest.requestId, "first");
  }
});

test("an external cancellation observed before a later block remains authoritative", async () => {
  const root = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = eventRuntime({ events: () => (async function* () {
    await gate;
    yield { type: "approval_requested", at, executionId, request: request() };
  })() });
  const running = await start(root, runtime);
  const cancelling = running.cancel("shutdown");
  release();
  await assert.rejects(running.result, /Execution cancelled: shutdown/u);
  await cancelling;
});

test("an unresolved request requires the repository to select the block policy", async () => {
  const root = await fixture(null);
  const item = task();
  await assert.rejects(engine(root, blockingRuntime()).withEnvironment(item, (environment) => environment.start({
    task: item, role: { name: "implementation", instructions: "" }, comments: [], artifacts: [], executionId: "execution-policy",
  })), /operatorRequests: block/u);
});

test("an invalid operator-request policy is rejected before workspace allocation", async () => {
  const root = await fixture("sometimes");
  const spaces = new FixedWorkspaces(root);
  await assert.rejects(engine(root, blockingRuntime(), spaces).withEnvironment(task(), async () => undefined), /operatorRequests: block/u);
  assert.equal(spaces.cleaned, 0);
});

test("blocked work reconstructs, waits for provider resolution, and resumes the same role with a new ID", async () => {
  const root = await fixture();
  const provider = new InMemoryProvider([task()], () => true, {
    executionId: (_taskId, historyLength) => `execution-${historyLength + 1}`,
  });
  const first = new Scheduler(provider, engine(root, blockingRuntime()));
  assert.equal((await first.poll())[0]?.outcome, "blocked");
  assert.equal((await provider.getTask("42")).status, "blocked");
  const blockedState = await provider.getExecutionState("42");
  assert.equal(blockedState.active, undefined);
  assert.equal(blockedState.nextRole, "implementation");
  assert.equal(blockedState.history[0]?.blockingRequest?.requestId, "approval-1");

  const whileBlocked = new Scheduler(provider, engine(root, new ScriptedRuntime("controlled", {
    outcome: "approved", summary: "should not run", comments: [], artifacts: [],
  })));
  assert.deepEqual(await whileBlocked.poll(), []);

  await provider.updateStatus("42", "ready");
  const resumedRuntime = new ScriptedRuntime("controlled", { outcome: "approved", summary: "resumed", comments: [], artifacts: [] });
  const resumed = new Scheduler(provider, engine(root, resumedRuntime));
  assert.equal((await resumed.poll())[0]?.outcome, "completed");
  const finished = await provider.getExecutionState("42");
  assert.deepEqual(finished.history.map((record) => record.id), ["execution-1", "execution-2"]);
  assert.equal(finished.history[0]?.outcome, "blocked");
  assert.equal(finished.history[1]?.role, "implementation");
  assert.equal(resumedRuntime.contexts[0]?.executionId, "execution-2");
});

test("a duplicate old block cannot clear or relabel a newer active claim", async () => {
  const provider = new InMemoryProvider([task()], () => true, { executionId: (_id, count) => `execution-${count + 1}` });
  const old = await provider.beginExecution("42", "implementation", "running", leaseClaim());
  const cancellation = {
    record: { id: old.id, role: old.role, outcome: "blocked", summary: "Approve", nextRole: old.role,
      finishedAt: "2026-08-01T10:00:00.000Z", blockingRequest: { kind: "approval" as const, summary: "Approve",
        requestId: "approval-old", createdAt: "2026-08-01T10:00:00.000Z" } },
    status: "blocked", comment: "Approve",
  };
  await provider.blockExecution("42", old.id, leaseGuard(old), cancellation);
  await provider.updateStatus("42", "ready");
  const current = await provider.beginExecution("42", "implementation", "running", leaseClaim());
  await provider.blockExecution("42", old.id, leaseGuard(old), cancellation);
  assert.equal((await provider.getTask("42")).status, "running");
  assert.equal((await provider.getExecutionState("42")).active?.id, current.id);
  assert.equal((await provider.getExecutionState("42")).history.length, 1);
});

test("provider reconstruction rejects inconsistent or non-exact blocking history", async () => {
  const baseRecord = { id: "execution-1", role: "implementation", summary: "Stopped", nextRole: "implementation",
    finishedAt: at };
  const malformed = [
    { ...baseRecord, outcome: "blocked" },
    { ...baseRecord, outcome: "approved", blockingRequest: request() },
    { ...baseRecord, outcome: "blocked", blockingRequest: { ...request(), providerCredential: "secret" } },
  ];
  for (const record of malformed) {
    const item = { ...task(), metadata: { executionHistory: [record] } };
    const provider = new InMemoryProvider([item]);
    await assert.rejects(provider.getExecutionState(item.id), /Invalid (execution record|blocking request)/u);
  }
});

test("a lost block response repairs idempotently before any redispatch", async () => {
  const root = await fixture();
  const delegate = new InMemoryProvider([task()], (candidate) => candidate.status === "ready" || candidate.status === "running");
  let calls = 0;
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "blockExecution") return async (...arguments_: Parameters<ProviderAdapter["blockExecution"]>) => {
        calls += 1;
        await target.blockExecution(...arguments_);
        if (calls === 1) throw new Error("block response lost");
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...arguments_: never[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const scheduler = new Scheduler(provider, engine(root, blockingRuntime()));
  assert.equal((await scheduler.poll())[0]?.outcome, "failed");
  assert.deepEqual(await scheduler.poll(), []);
  assert.equal(calls, 2);
  const state = await delegate.getExecutionState("42");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0]?.outcome, "blocked");
});
