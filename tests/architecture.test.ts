import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionEngine,
  InMemoryProvider,
  RepositoryConfigLoader,
  RuntimeRegistry,
  Scheduler,
  ScriptedRuntime,
  WorkspaceConfigurationResolver,
} from "../src/index.ts";
import type {
  ProviderAdapter,
  RepositoryRef,
  Runtime,
  RuntimeEvent,
  Task,
  Workspace,
  WorkspaceManager,
} from "../src/index.ts";

const repository: RepositoryRef = { id: "architecture", url: "local://architecture" };

function task(id: string, status = "todo", metadata?: Readonly<Record<string, unknown>>): Task {
  return { id, title: id, description: "work", acceptanceCriteria: [], status, labels: [], assignees: [], repository, metadata };
}

async function fixture(maxFailures = 3): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-architecture-"));
  await mkdir(join(root, ".ensemble", "roles"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Test.");
  await writeFile(join(root, ".ensemble", "WORKFLOW.md"), "Work.");
  await writeFile(join(root, ".ensemble", "roles", "implementation.md"), "Implement.");
  await writeFile(join(root, ".ensemble", "roles", "reviewer.md"), "Review.");
  await writeFile(join(root, ".ensemble", "config.yaml"), [
    "runtime:", "  name: scripted", "initialRole: implementation",
    "terminalOutcomes: [approved]", "statuses:", "  runnable: [todo, in_progress]",
    "  running: in_progress", "  completed: done", "  failed: failed",
    "retry:", `  maxFailedAttemptsPerRole: ${maxFailures}`,
  ].join("\n"));
  return root;
}

class CountingWorkspaces implements WorkspaceManager {
  created = 0;
  cleaned = 0;
  readonly repositoryPath: string;
  readonly cleanupError?: Error;
  constructor(repositoryPath: string, cleanupError?: Error) {
    this.repositoryPath = repositoryPath;
    this.cleanupError = cleanupError;
  }
  async create(item: Task): Promise<Workspace> {
    this.created += 1;
    return { root: `/w/${item.id}`, repositoryPath: this.repositoryPath, runtimePath: `/w/${item.id}/runtime` };
  }
  async restore(): Promise<Workspace | undefined> { return undefined; }
  async cleanup(): Promise<void> { this.cleaned += 1; if (this.cleanupError) throw this.cleanupError; }
}

function scheduler(provider: ProviderAdapter, runtime: Runtime, workspaces: WorkspaceManager): Scheduler {
  return new Scheduler(provider, new ExecutionEngine(
    new RuntimeRegistry([runtime]), workspaces,
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader()),
  ));
}

function failingRuntime(message = "boom"): Runtime {
  return {
    name: "scripted",
    prepare: async (context) => ({ id: "failure", context, payload: null }),
    start: async () => ({ id: "failure", events: (async function* () {})(), result: Promise.reject(new Error(message)) }),
    resume: async (session) => session,
    cancel: async () => undefined,
  };
}

test("typed provider state is validated, ordered, copied, and orchestration ignores task metadata", async () => {
  const root = await fixture();
  const delegate = new InMemoryProvider([task("typed", "todo", { nextRole: "metadata-hijack" })]);
  const provider = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "getExecutionState") return async () => Object.freeze({ history: Object.freeze([]), nextRole: undefined });
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  const runtime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "ok", comments: [], artifacts: [] });
  assert.equal((await scheduler(provider, runtime, new CountingWorkspaces(root)).poll())[0]?.role, "implementation");

  const later = { id: "later", role: "implementation", outcome: "failed", summary: "later", finishedAt: "2026-01-02T00:00:00Z" };
  const earlier = { id: "earlier", role: "implementation", outcome: "failed", summary: "earlier", finishedAt: "2026-01-01T00:00:00Z" };
  const stateProvider = new InMemoryProvider([task("state", "failed", {
    activeExecution: { id: "active", role: "reviewer", startedAt: "2026-01-03T00:00:00Z" },
    executionHistory: [later, earlier], nextRole: "reviewer",
  })]);
  const state = await stateProvider.getExecutionState("state");
  assert.deepEqual(state.history.map((record) => record.id), ["earlier", "later"]);
  later.summary = "mutated after read";
  assert.equal(state.history[1]?.summary, "later");
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.history), true);
  assert.equal(Object.isFrozen(state.history[0]), true);
  assert.equal(Object.isFrozen(state.active), true);

  await assert.rejects(new InMemoryProvider([task("bad-container", "todo", { executionHistory: "bad" })]).getExecutionState("bad-container"), /Invalid execution history/u);
  await assert.rejects(new InMemoryProvider([task("bad-record", "todo", { executionHistory: [{ id: 1 }] })]).getExecutionState("bad-record"), /Invalid execution record/u);
  await assert.rejects(new InMemoryProvider([task("bad-active", "todo", { activeExecution: { id: "x" } })]).getExecutionState("bad-active"), /Invalid active execution/u);
  await assert.rejects(new InMemoryProvider([task("bad-role", "todo", { nextRole: 42 })]).getExecutionState("bad-role"), /Invalid next role/u);
});

test("retry state survives Scheduler reconstruction and caps failures per role", async () => {
  const root = await fixture(2);
  const recoveredProvider = new InMemoryProvider([task("recovered-retry")]);
  assert.equal((await scheduler(recoveredProvider, failingRuntime(), new CountingWorkspaces(root)).poll())[0]?.outcome, "failed");
  const recoveredRuntime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "recovered", comments: [], artifacts: [] });
  assert.equal((await scheduler(recoveredProvider, recoveredRuntime, new CountingWorkspaces(root)).poll())[0]?.outcome, "completed");

  const provider = new InMemoryProvider([task("bounded")]);
  const run = scheduler(provider, failingRuntime(), new CountingWorkspaces(root));
  assert.equal((await run.poll())[0]?.outcome, "failed");
  assert.equal((await run.poll())[0]?.outcome, "failed");
  assert.deepEqual(await run.poll(), []);
  assert.equal((await provider.getExecutionState("bounded")).history.length, 2);

  const zeroRoot = await fixture(0);
  const zeroProvider = new InMemoryProvider([task("zero")]);
  const zero = scheduler(zeroProvider, failingRuntime(), new CountingWorkspaces(zeroRoot));
  assert.equal((await zero.poll())[0]?.outcome, "failed");
  assert.deepEqual(await zero.poll(), []);
});

test("failures in an earlier role do not exhaust a later role", async () => {
  const root = await fixture(1);
  const provider = new InMemoryProvider([task("roles")]);
  const execution = await provider.beginExecution("roles", "implementation", "in_progress");
  await provider.failExecution("roles", execution.id, {
    id: execution.id, role: "implementation", outcome: "failed", summary: "failed",
    nextRole: "reviewer", finishedAt: new Date().toISOString(),
  }, "failed", "failed");
  const runtime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "reviewed", comments: [], artifacts: [] });
  assert.equal((await scheduler(provider, runtime, new CountingWorkspaces(root)).poll())[0]?.role, "reviewer");
});

test("durable active execution bypasses status and retry eligibility", async () => {
  const root = await fixture(0);
  const provider = new InMemoryProvider([task("recover", "archived")]);
  const active = await provider.beginExecution("recover", "reviewer", "archived");
  const runtime = new ScriptedRuntime("scripted", { outcome: "approved", summary: "recovered", comments: [], artifacts: [] });
  const [report] = await scheduler(provider, runtime, new CountingWorkspaces(root)).poll();
  assert.equal(report?.role, "reviewer");
  assert.equal((await provider.getExecutionState("recover")).history[0]?.id, active.id);
});

test("engine cleans after rejection, provider read failure, and configuration failure", async () => {
  const root = await fixture();
  const ignoredSpaces = new CountingWorkspaces(root);
  const ignored = new InMemoryProvider([task("ignored", "not-runnable")]);
  assert.deepEqual(await scheduler(ignored, new ScriptedRuntime("scripted", { outcome: "approved", summary: "ok", comments: [], artifacts: [] }), ignoredSpaces).poll(), []);
  assert.equal(ignoredSpaces.cleaned, 1);

  const failingSpaces = new CountingWorkspaces(root);
  const base = new InMemoryProvider([task("provider-read")]);
  const badProvider = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "getExecutionState") return async () => { throw new Error("provider unavailable"); };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ProviderAdapter;
  assert.match((await scheduler(badProvider, new ScriptedRuntime("scripted", { outcome: "approved", summary: "ok", comments: [], artifacts: [] }), failingSpaces).poll())[0]?.error ?? "", /provider unavailable/u);
  assert.equal(failingSpaces.cleaned, 1);

  const missing = await mkdtemp(join(tmpdir(), "ensemble-missing-config-"));
  const configSpaces = new CountingWorkspaces(missing);
  assert.equal((await scheduler(new InMemoryProvider([task("bad-config")]), failingRuntime(), configSpaces).poll())[0]?.outcome, "failed");
  assert.equal(configSpaces.cleaned, 1);
});

test("environment is single-use and closed after its callback", async () => {
  const root = await fixture();
  const engine = new ExecutionEngine(new RuntimeRegistry([new ScriptedRuntime("scripted", {
    outcome: "approved", summary: "ok", comments: [], artifacts: [],
  })]), new CountingWorkspaces(root), new WorkspaceConfigurationResolver(new RepositoryConfigLoader()));
  let captured: import("../src/index.ts").ExecutionEnvironment | undefined;
  const request = { task: task("capability"), role: { name: "implementation", instructions: "" }, comments: [], artifacts: [], executionId: "x" };
  await engine.withEnvironment(request.task, async (environment) => {
    captured = environment;
    await environment.run(request);
    await assert.rejects(environment.run(request), /single-use/u);
  });
  await assert.rejects(captured!.run(request), /closed/u);
});

test("runtime result errors remain primary over event, cancellation, and cleanup failures", async () => {
  const root = await fixture();
  let cancelled = false;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<never>((_resolve, reject) => { rejectResult = reject; });
  const runtime: Runtime = {
    name: "scripted",
    prepare: async (context) => ({ id: "race", context, payload: null }),
    start: async () => ({
      id: "race",
      events: (async function* (): AsyncIterable<RuntimeEvent> { throw new Error("event failed"); })(),
      result,
    }),
    resume: async (session) => session,
    cancel: async () => { cancelled = true; rejectResult(new Error("result failed")); throw new Error("cancel failed"); },
  };
  const spaces = new CountingWorkspaces(root, new Error("cleanup failed"));
  const provider = new InMemoryProvider([task("primary")]);
  const [report] = await scheduler(provider, runtime, spaces).poll();
  assert.match(report?.error ?? "", /result failed/u);
  assert.equal(cancelled, true);
  assert.equal(spaces.cleaned, 1);
});

test("event-stream rejection cannot hang on a pending runtime result", async () => {
  const root = await fixture();
  const runtime: Runtime = {
    name: "scripted",
    prepare: async (context) => ({ id: "stream", context, payload: null }),
    start: async () => ({
      id: "stream",
      events: (async function* (): AsyncIterable<RuntimeEvent> { throw new Error("stream stopped"); })(),
      result: new Promise(() => undefined),
    }),
    resume: async (session) => session,
    cancel: async () => undefined,
  };
  const provider = new InMemoryProvider([task("stream")]);
  const [report] = await scheduler(provider, runtime, new CountingWorkspaces(root)).poll();
  assert.match(report?.error ?? "", /stream stopped/u);
});

test("provider candidate discovery prevents non-candidates from allocating", async () => {
  const root = await fixture();
  const provider = new InMemoryProvider([task("completed", "done")], (candidate) => candidate.status !== "done");
  const spaces = new CountingWorkspaces(root);
  assert.deepEqual(await scheduler(provider, failingRuntime(), spaces).poll(), []);
  assert.equal(spaces.created, 0);
});

test("retry configuration rejects negative and fractional values", async () => {
  for (const value of ["-1", "1.5"]) {
    const root = await fixture();
    await writeFile(join(root, ".ensemble", "config.yaml"), [
      "runtime:", "  name: scripted", "retry:", `  maxFailedAttemptsPerRole: ${value}`,
    ].join("\n"));
    await assert.rejects(new RepositoryConfigLoader().load(repository, root), /non-negative integer/u);
  }
});
