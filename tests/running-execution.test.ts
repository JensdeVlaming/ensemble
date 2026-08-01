import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionCancelledError,
  ExecutionEngine,
  RepositoryConfigLoader,
  RuntimeRegistry,
  WorkspaceConfigurationResolver,
} from "../src/index.ts";
import type {
  RepositoryRef,
  Runtime,
  RuntimeEvent,
  RuntimeResult,
  Task,
  Workspace,
  WorkspaceManager,
} from "../src/index.ts";

const repository: RepositoryRef = { id: "running", url: "local://running" };

function task(id: string): Task {
  return {
    id,
    title: id,
    description: "Run",
    acceptanceCriteria: [],
    status: "todo",
    labels: [],
    assignees: [],
    repository,
  };
}

async function fixture(cancellationMs = 10_000, runtimeStartMs = 30_000): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-running-"));
  await mkdir(join(root, ".ensemble", "roles"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Test.");
  await writeFile(join(root, ".ensemble", "WORKFLOW.md"), "Run.");
  await writeFile(join(root, ".ensemble", "roles", "implementation.md"), "Implement.");
  await writeFile(join(root, ".ensemble", "config.yaml"), [
    "runtime:",
    "  name: controlled",
    "initialRole: implementation",
    "timeouts:",
    `  cancellationMs: ${cancellationMs}`,
    `  runtimeStartMs: ${runtimeStartMs}`,
  ].join("\n"));
  return root;
}

class TrackingWorkspaces implements WorkspaceManager {
  cleaned = 0;
  readonly repositoryPath: string;
  readonly cleanupResult: Promise<void>;

  constructor(repositoryPath: string, cleanupResult = Promise.resolve()) {
    this.repositoryPath = repositoryPath;
    this.cleanupResult = cleanupResult;
  }

  async create(item: Task): Promise<Workspace> {
    return { root: `/running/${item.id}`, repositoryPath: this.repositoryPath, runtimePath: `/running/${item.id}/runtime` };
  }

  async restore(): Promise<Workspace | undefined> { return undefined; }

  cleanup(): Promise<void> {
    this.cleaned += 1;
    return this.cleanupResult;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request(item: Task) {
  return {
    task: item,
    role: { name: "implementation", instructions: "Implement." },
    comments: [],
    artifacts: [],
    executionId: `execution-${item.id}`,
  };
}

test("starting returns a live handle that owns activity, diagnostics, and workspace cleanup", async () => {
  const root = await fixture();
  const item = task("non-blocking");
  const result = deferred<RuntimeResult>();
  const emitProgress = deferred<void>();
  const finishEvents = deferred<void>();
  const progressObserved = deferred<void>();
  const workspaces = new TrackingWorkspaces(root);
  const runtime: Runtime = {
    name: "controlled",
    prepare: async (context) => ({ id: "prepared", context, payload: null }),
    start: async () => ({
      id: "runtime-session",
      events: (async function* (): AsyncIterable<RuntimeEvent> {
        yield { type: "run_started", at: "ignored", sessionId: "runtime-session" };
        await emitProgress.promise;
        yield { type: "progress_updated", at: "ignored", message: "working" };
        await finishEvents.promise;
        yield { type: "run_completed", at: "ignored", result: { outcome: "approved", summary: "done", comments: [], artifacts: [] } };
      })(),
      result: result.promise,
    }),
    resume: async (session) => session,
    cancel: async () => undefined,
  };
  const timestamps = ["2026-07-31T10:00:00.000Z", "2026-07-31T10:01:00.000Z", "2026-07-31T10:02:00.000Z"];
  const engine = new ExecutionEngine(
    new RuntimeRegistry([runtime]),
    workspaces,
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root),
    (event) => { if (event.type === "progress_updated") progressObserved.resolve(); },
    0,
    () => timestamps.shift() ?? "2026-07-31T10:03:00.000Z",
  );

  const running = await engine.withEnvironment(item, async (environment) => environment.start(request(item)));
  assert.equal(workspaces.cleaned, 0);
  assert.equal(running.startedAt, "2026-07-31T10:00:00.000Z");
  assert.equal(running.lastActivityAt, running.startedAt);
  assert.deepEqual(running.snapshot(), {
    executionId: "execution-non-blocking",
    taskId: "non-blocking",
    role: "implementation",
    runtimeSessionId: "runtime-session",
    workspacePath: "/running/non-blocking",
    state: "running",
    startedAt: "2026-07-31T10:00:00.000Z",
    lastActivityAt: "2026-07-31T10:00:00.000Z",
  });
  assert.equal(Object.isFrozen(running.snapshot()), true);

  emitProgress.resolve();
  await progressObserved.promise;
  assert.equal(running.lastActivityAt, "2026-07-31T10:01:00.000Z");
  result.resolve({ outcome: "approved", summary: "done", comments: [], artifacts: [] });
  finishEvents.resolve();
  assert.equal((await running.result).result.outcome, "approved");
  assert.equal(workspaces.cleaned, 1);
  assert.deepEqual(running.snapshot(), {
    executionId: "execution-non-blocking",
    taskId: "non-blocking",
    role: "implementation",
    runtimeSessionId: "runtime-session",
    workspacePath: "/running/non-blocking",
    state: "completed",
    startedAt: "2026-07-31T10:00:00.000Z",
    lastActivityAt: "2026-07-31T10:01:00.000Z",
    finishedAt: "2026-07-31T10:02:00.000Z",
  });
});

test("startup failure before runtime preparation releases transferred workspace ownership", async () => {
  const root = await fixture();
  const item = task("unknown-runtime");
  const workspaces = new TrackingWorkspaces(root);
  const engine = new ExecutionEngine(
    new RuntimeRegistry(),
    workspaces,
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root),
  );

  await assert.rejects(
    engine.withEnvironment(item, async (environment) => environment.start(request(item))),
    /Unknown runtime: controlled/u,
  );
  assert.equal(workspaces.cleaned, 1);
});

test("runtime startup is bounded and a late session is cancelled without retaining its workspace", async () => {
  const root = await fixture(10_000, 1);
  const item = task("late-start");
  const workspaces = new TrackingWorkspaces(root);
  const startup = deferred<Awaited<ReturnType<Runtime["start"]>>>();
  let cancellations = 0;
  const runtime: Runtime = {
    name: "controlled",
    prepare: async (context) => ({ id: "prepared", context, payload: null }),
    start: () => startup.promise,
    resume: async (session) => session,
    cancel: async () => { cancellations += 1; },
  };
  const engine = new ExecutionEngine(new RuntimeRegistry([runtime]), workspaces,
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root));

  await assert.rejects(
    engine.withEnvironment(item, async (environment) => environment.start(request(item))),
    /Runtime start timed out/u,
  );
  assert.equal(workspaces.cleaned, 1);
  startup.resolve({
    id: "late-session",
    events: (async function* (): AsyncIterable<RuntimeEvent> {})(),
    result: new Promise<RuntimeResult>(() => undefined),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancellations, 1);
});

test("cancellation is first-reason, idempotent, bounded, and observes detached failures", async () => {
  const root = await fixture(0);
  const item = task("cancel");
  const runtimeResult = deferred<RuntimeResult>();
  const eventNext = deferred<IteratorResult<RuntimeEvent>>();
  const never = new Promise<void>(() => undefined);
  const workspaces = new TrackingWorkspaces(root, never);
  let cancellations = 0;
  const runtime: Runtime = {
    name: "controlled",
    prepare: async (context) => ({ id: "prepared", context, payload: null }),
    start: async () => ({
      id: "runtime-session",
      events: { [Symbol.asyncIterator]: () => ({ next: () => eventNext.promise }) },
      result: runtimeResult.promise,
    }),
    resume: async (session) => session,
    cancel: async () => { cancellations += 1; await never; },
  };
  const engine = new ExecutionEngine(
    new RuntimeRegistry([runtime]),
    workspaces,
    new WorkspaceConfigurationResolver(new RepositoryConfigLoader(), root),
    () => undefined,
    0,
  );
  const running = await engine.withEnvironment(item, async (environment) => environment.start(request(item)));
  const first = running.cancel("shutdown");
  const second = running.cancel("operator");
  assert.equal(first, second);
  await Promise.race([
    first,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancellation was not bounded")), 100)),
  ]);
  await assert.rejects(running.result, (error: unknown) => {
    assert.equal(error instanceof ExecutionCancelledError, true);
    assert.equal((error as ExecutionCancelledError).reason, "shutdown");
    return true;
  });
  assert.equal(cancellations, 1);
  assert.equal(workspaces.cleaned, 1);
  assert.equal(running.snapshot().state, "cancelled");
  assert.equal(running.snapshot().cancellationReason, "shutdown");

  runtimeResult.reject(new Error("late result rejection"));
  eventNext.reject(new Error("late event rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
