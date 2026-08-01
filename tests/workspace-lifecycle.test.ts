import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessTerminationUnconfirmedError } from "../src/execution/process.ts";
import {
  ExecutionEngine,
  ExecutionCancelledError,
  LocalWorkspaceHookRunner,
  RuntimeRegistry,
  ScriptedRuntime,
} from "../src/index.ts";
import type {
  RepositoryConfiguration,
  Task,
  Workspace,
  WorkspaceCleanupOptions,
  WorkspaceHook,
  WorkspaceHookRunner,
  WorkspaceManager,
  Runtime,
  RuntimeContext,
  RuntimeEvent,
  RuntimeResult,
} from "../src/index.ts";

const repository = { id: "hooks", url: "local://hooks" };
const item: Task = { id: "task", title: "Hooks", description: "Run hooks", acceptanceCriteria: [], status: "ready",
  labels: [], assignees: [], repository };
const workspace: Workspace = { root: "/workspaces/task", repositoryPath: "/workspaces/task/repository",
  runtimePath: "/workspaces/task/.ensemble-runtime" };

function configuration(runtimeName = "scripted"): RepositoryConfiguration {
  const hook = (name: string): WorkspaceHook => ({ executable: name, args: ["--exact", "two words"] });
  return {
    repository,
    workflow: { instructions: "Work", roles: [{ name: "implementation", instructions: "Implement" }] },
    agents: "Rules", runtime: { name: runtimeName, config: {} }, initialRole: "implementation",
    terminalOutcomes: ["approved"], runnableStatuses: ["ready"], runningStatus: "running",
    completedStatus: "completed", failedStatus: "failed", blockedStatus: "blocked",
    service: { pollIntervalMs: 1 }, concurrency: { global: 1, byStatus: {} },
    retry: { maxFailedAttemptsPerRole: 0, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1, jitterRatio: 0,
      retryableFailureKinds: [] },
    timeouts: { startupMs: 100, providerMs: 100, runtimeStartMs: 100, turnMs: 1_000, stallMs: 1_000,
      cancellationMs: 10 },
    shutdown: { drainTimeoutMs: 10 },
    workspace: { hooks: { afterCreate: hook("afterCreate"), beforeRun: hook("beforeRun"),
      afterRun: hook("afterRun"), beforeRemove: hook("beforeRemove") }, hookTimeoutMs: 25 },
  };
}

class LifecycleWorkspaces implements WorkspaceManager {
  removed = 0;
  validated = 0;
  async create(): Promise<Workspace> { return workspace; }
  async restore(): Promise<Workspace | undefined> { return undefined; }
  async validate(): Promise<void> { this.validated += 1; }
  async cleanup(_workspace: Workspace, options?: WorkspaceCleanupOptions): Promise<void> {
    await options?.beforeRemove?.();
    this.removed += 1;
  }
}

class RecordingHooks implements WorkspaceHookRunner {
  readonly calls: string[] = [];
  readonly failures = new Set<string>();
  readonly unconfirmed = new Set<string>();
  async run(hook: WorkspaceHook, cwd: string, timeoutMs: number): Promise<void> {
    assert.equal(cwd, workspace.repositoryPath);
    assert.equal(timeoutMs, 25);
    assert.deepEqual(hook.args, ["--exact", "two words"]);
    this.calls.push(hook.executable);
    if (this.unconfirmed.has(hook.executable)) throw new ProcessTerminationUnconfirmedError("Workspace hook");
    if (this.failures.has(hook.executable)) throw new Error(`${hook.executable} sentinel must stay primary only when specified`);
  }
}

function engine(workspaces: LifecycleWorkspaces, hooks: RecordingHooks): ExecutionEngine {
  return engineWithRuntime(workspaces, hooks, new ScriptedRuntime("scripted", {
      outcome: "approved", summary: "done", comments: [], artifacts: [],
    }));
}

function engineWithRuntime(workspaces: LifecycleWorkspaces, hooks: RecordingHooks, runtime: Runtime): ExecutionEngine {
  return new ExecutionEngine(
    new RuntimeRegistry([runtime]),
    workspaces,
    { resolve: async () => configuration(runtime.name) },
    undefined,
    0,
    () => "2026-08-01T00:00:00.000Z",
    undefined,
    hooks,
  );
}

async function execute(service: ExecutionEngine) {
  const running = await service.withEnvironment(item, (environment) => environment.start({
    task: item, role: { name: "implementation", instructions: "Implement" }, comments: [], artifacts: [], executionId: "execution",
  }));
  return running.result;
}

test("workspace lifecycle hooks run in order with afterRun and beforeRemove secondary", async () => {
  const workspaces = new LifecycleWorkspaces();
  const hooks = new RecordingHooks();
  hooks.failures.add("afterRun");
  hooks.failures.add("beforeRemove");
  const report = await execute(engine(workspaces, hooks));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(report.kind, "completed");
  assert.deepEqual(hooks.calls, ["afterCreate", "beforeRun", "afterRun", "beforeRemove"]);
  assert.equal(workspaces.validated, 1);
  assert.equal(workspaces.removed, 1);
});

test("afterCreate and beforeRun failures remain primary while cleanup semantics stay bounded", async () => {
  const afterCreateWorkspaces = new LifecycleWorkspaces();
  const afterCreateHooks = new RecordingHooks();
  afterCreateHooks.failures.add("afterCreate");
  await assert.rejects(execute(engine(afterCreateWorkspaces, afterCreateHooks)), /afterCreate sentinel/u);
  assert.deepEqual(afterCreateHooks.calls, ["afterCreate", "beforeRemove"]);
  assert.equal(afterCreateWorkspaces.removed, 1);

  const beforeRunWorkspaces = new LifecycleWorkspaces();
  const beforeRunHooks = new RecordingHooks();
  beforeRunHooks.failures.add("beforeRun");
  await assert.rejects(execute(engine(beforeRunWorkspaces, beforeRunHooks)), /beforeRun sentinel/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(beforeRunHooks.calls, ["afterCreate", "beforeRun", "afterRun", "beforeRemove"]);
  assert.equal(beforeRunWorkspaces.removed, 1);
});

test("local hook runner uses argv, repository cwd, minimal environment, output bounds, and timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ensemble-hook-runner-"));
  const runner = new LocalWorkspaceHookRunner();
  const previous = process.env.VIKUNJA_TOKEN;
  process.env.VIKUNJA_TOKEN = "provider-secret-sentinel";
  try {
    await runner.run({ executable: process.execPath, args: ["-e",
      "require('node:fs').writeFileSync('hook.json',JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1),env:process.env}))",
      "two words"] }, cwd, 2_000);
    const record = JSON.parse(await readFile(join(cwd, "hook.json"), "utf8")) as {
      cwd: string; argv: string[]; env: Record<string, string>;
    };
    assert.equal(record.cwd, await realpath(cwd));
    assert.deepEqual(record.argv, ["two words"]);
    assert.equal(record.env.VIKUNJA_TOKEN, undefined);
    assert.deepEqual(Object.keys(record.env).filter((name) => ![
      "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING",
    ].includes(name)), []);

    await assert.rejects(runner.run({ executable: process.execPath,
      args: ["-e", "process.stdout.write('provider-secret-sentinel'.repeat(5000))"] }, cwd, 2_000), (error: unknown) => {
      assert.equal((error as Error).message, "Workspace hook output exceeded its limit");
      assert.doesNotMatch(String(error), /provider-secret-sentinel/u);
      return true;
    });
    await assert.rejects(runner.run({ executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('hook.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]
    }, cwd, 50), /timed out/u);
    const childPid = Number(await readFile(join(cwd, "hook.pid"), "utf8"));
    assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");

    if (process.platform !== "win32") {
      await assert.rejects(runner.run({ executable: process.execPath, args: ["-e", [
        "const fs=require('node:fs'),{spawn}=require('node:child_process')",
        "spawn(process.execPath,['-e',\"require('node:fs').writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)\"],{stdio:'ignore'})",
        "const timer=setInterval(()=>{if(fs.existsSync('descendant.pid')){clearInterval(timer);process.exit(0)}},5)",
      ].join(";")] }, cwd, 2_000), /left background processes running/u);
      const descendantPid = Number(await readFile(join(cwd, "descendant.pid"), "utf8"));
      assert.throws(() => process.kill(descendantPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    }
  } finally {
    if (previous === undefined) delete process.env.VIKUNJA_TOKEN;
    else process.env.VIKUNJA_TOKEN = previous;
  }
});

class LifecycleRuntime implements Runtime {
  readonly name: string;
  readonly startError?: Error;
  readonly result: Promise<RuntimeResult>;
  readonly events: AsyncIterable<RuntimeEvent>;

  constructor(options: {
    readonly name: string;
    readonly result: Promise<RuntimeResult>;
    readonly events?: AsyncIterable<RuntimeEvent>;
    readonly startError?: Error;
  }) {
    this.name = options.name;
    this.result = options.result;
    this.events = options.events ?? emptyEvents();
    this.startError = options.startError;
  }

  async prepare(context: RuntimeContext) {
    return { id: context.executionId, context, payload: {}, operatorRequests: "block" as const };
  }

  async start() {
    if (this.startError) throw this.startError;
    return { id: `${this.name}-session`, events: this.events, result: this.result };
  }

  async resume(): Promise<never> { throw new Error("not used"); }
  async cancel() {}
}

async function* emptyEvents(): AsyncIterable<RuntimeEvent> {}

async function* blockingEvents(): AsyncIterable<RuntimeEvent> {
  yield { type: "approval_requested", at: "2026-08-01T00:00:00.000Z", executionId: "execution",
    request: { kind: "approval", summary: "Approve", createdAt: "2026-08-01T00:00:00.000Z" } };
  await new Promise<never>(() => undefined);
}

function pendingResult(): Promise<RuntimeResult> {
  return new Promise<RuntimeResult>(() => undefined);
}

async function assertLifecycleSettled(workspaces: LifecycleWorkspaces, hooks: RecordingHooks): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hooks.calls, ["afterCreate", "beforeRun", "afterRun", "beforeRemove"]);
  assert.equal(workspaces.removed, 1);
}

test("runtime result failure preserves the primary error and completes all terminal hooks once", async () => {
  const workspaces = new LifecycleWorkspaces();
  const hooks = new RecordingHooks();
  hooks.failures.add("afterRun");
  hooks.failures.add("beforeRemove");
  const primary = new Error("runtime result primary");
  const runtime = new LifecycleRuntime({ name: "result-failure", result: Promise.reject(primary) });
  await assert.rejects(execute(engineWithRuntime(workspaces, hooks, runtime)), (error: unknown) => error === primary);
  await assertLifecycleSettled(workspaces, hooks);
});

test("runtime start failure preserves the primary error and completes all attempted-run hooks once", async () => {
  const workspaces = new LifecycleWorkspaces();
  const hooks = new RecordingHooks();
  hooks.failures.add("afterRun");
  hooks.failures.add("beforeRemove");
  const primary = new Error("runtime start primary");
  const runtime = new LifecycleRuntime({ name: "start-failure", result: pendingResult(), startError: primary });
  await assert.rejects(execute(engineWithRuntime(workspaces, hooks, runtime)), (error: unknown) => error === primary);
  await assertLifecycleSettled(workspaces, hooks);
});

test("blocked execution completes afterRun and beforeRemove exactly once", async () => {
  const workspaces = new LifecycleWorkspaces();
  const hooks = new RecordingHooks();
  hooks.failures.add("afterRun");
  hooks.failures.add("beforeRemove");
  const runtime = new LifecycleRuntime({ name: "blocked", result: pendingResult(), events: blockingEvents() });
  const report = await execute(engineWithRuntime(workspaces, hooks, runtime));
  assert.equal(report.kind, "blocked");
  await assertLifecycleSettled(workspaces, hooks);
});

test("cancelled execution completes afterRun and beforeRemove exactly once", async () => {
  const workspaces = new LifecycleWorkspaces();
  const hooks = new RecordingHooks();
  hooks.failures.add("afterRun");
  hooks.failures.add("beforeRemove");
  const runtime = new LifecycleRuntime({ name: "cancelled", result: pendingResult(), events: asyncEventsPending() });
  const service = engineWithRuntime(workspaces, hooks, runtime);
  const running = await service.withEnvironment(item, (environment) => environment.start({
    task: item, role: { name: "implementation", instructions: "Implement" }, comments: [], artifacts: [], executionId: "execution",
  }));
  await running.cancel("shutdown");
  await assert.rejects(running.result, (error: unknown) => error instanceof ExecutionCancelledError && error.reason === "shutdown");
  await assertLifecycleSettled(workspaces, hooks);
});

test("unconfirmed hook process termination prevents every later destructive transition", async () => {
  const afterCreateWorkspaces = new LifecycleWorkspaces();
  const afterCreateHooks = new RecordingHooks();
  afterCreateHooks.unconfirmed.add("afterCreate");
  await assert.rejects(execute(engine(afterCreateWorkspaces, afterCreateHooks)), ProcessTerminationUnconfirmedError);
  assert.deepEqual(afterCreateHooks.calls, ["afterCreate"]);
  assert.equal(afterCreateWorkspaces.removed, 0);

  const beforeRunWorkspaces = new LifecycleWorkspaces();
  const beforeRunHooks = new RecordingHooks();
  beforeRunHooks.unconfirmed.add("beforeRun");
  await assert.rejects(execute(engine(beforeRunWorkspaces, beforeRunHooks)), ProcessTerminationUnconfirmedError);
  assert.deepEqual(beforeRunHooks.calls, ["afterCreate", "beforeRun"]);
  assert.equal(beforeRunWorkspaces.removed, 0);

  const afterRunWorkspaces = new LifecycleWorkspaces();
  const afterRunHooks = new RecordingHooks();
  afterRunHooks.unconfirmed.add("afterRun");
  assert.equal((await execute(engine(afterRunWorkspaces, afterRunHooks))).kind, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(afterRunHooks.calls, ["afterCreate", "beforeRun", "afterRun"]);
  assert.equal(afterRunWorkspaces.removed, 0);

  const beforeRemoveWorkspaces = new LifecycleWorkspaces();
  const beforeRemoveHooks = new RecordingHooks();
  beforeRemoveHooks.unconfirmed.add("beforeRemove");
  assert.equal((await execute(engine(beforeRemoveWorkspaces, beforeRemoveHooks))).kind, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(beforeRemoveHooks.calls, ["afterCreate", "beforeRun", "afterRun", "beforeRemove"]);
  assert.equal(beforeRemoveWorkspaces.removed, 0);
});

async function* asyncEventsPending(): AsyncIterable<RuntimeEvent> {
  await new Promise<never>(() => undefined);
}
