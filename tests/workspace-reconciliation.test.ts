import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryProvider, LocalWorkspaceManager, Scheduler } from "../src/index.ts";
import type {
  ConfiguredExecution,
  ExecutionWorkspaceInventory,
  LegacyWorkspaceHandle,
  LegacyWorkspaceMatch,
  ManagedWorkspaceHandle,
  ProviderTaskInventory,
  RepositoryConfiguration,
  Task,
  TaskExecutionService,
  RepositoryDriver,
} from "../src/index.ts";

const repository = { id: "cleanup", url: "local://cleanup" } as const;

function task(id: string, status: string): Task {
  return { id, title: id, description: id, acceptanceCriteria: [], status, labels: [], assignees: [], repository };
}

const current = task("1", "ready");
const terminal = task("2", "completed");

const configuration: RepositoryConfiguration = {
  repository,
  workflow: { instructions: "work", roles: [{ name: "implementation", instructions: "work" }] },
  agents: "rules", runtime: { name: "fake", config: {} }, initialRole: "implementation",
  terminalOutcomes: ["approved"], runnableStatuses: ["ready"], runningStatus: "running",
  completedStatus: "completed", failedStatus: "failed", blockedStatus: "blocked",
  service: { pollIntervalMs: 1 }, concurrency: { global: 0, byStatus: {} },
  retry: { maxFailedAttemptsPerRole: 0, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1, jitterRatio: 0,
    retryableFailureKinds: [] },
  timeouts: { startupMs: 100, providerMs: 100, runtimeStartMs: 100, turnMs: 100, stallMs: 100, cancellationMs: 100 },
  shutdown: { drainTimeoutMs: 100 }, workspace: { hooks: {}, hookTimeoutMs: 100 },
};

const handle = (id: string) => Object.freeze({ id });

class InventoryProvider extends InMemoryProvider {
  inventory: ProviderTaskInventory;
  constructor(inventory: ProviderTaskInventory) {
    super(inventory.entries.map((entry) => entry.task));
    this.inventory = inventory;
  }
  override async inventoryTasks(): Promise<ProviderTaskInventory> { return this.inventory; }
}

class WorkspaceExecutions implements TaskExecutionService {
  readonly operations: string[] = [];
  inventory: ExecutionWorkspaceInventory;

  constructor(inventory: ExecutionWorkspaceInventory) { this.inventory = inventory; }
  async reloadConfiguration() { return { status: "unchanged" as const, revision: "one", configuration }; }
  async withConfiguration<T>(value: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
    this.operations.push(`configure:${value.id}`);
    return work({ configuration, withEnvironment: async () => { throw new Error("not dispatched"); } });
  }
  async inspectWorkspaces(): Promise<ExecutionWorkspaceInventory> {
    this.operations.push("inspect");
    return this.inventory;
  }
  async migrateLegacyWorkspace(match: Extract<LegacyWorkspaceMatch, { kind: "unique" }>): Promise<void> {
    this.operations.push(`migrate:${match.handle.id}`);
  }
  async quarantineLegacyWorkspace(value: LegacyWorkspaceHandle): Promise<void> { this.operations.push(`quarantine-legacy:${value.id}`); }
  async removeLegacyWorkspace(value: LegacyWorkspaceHandle, item?: Task): Promise<void> {
    this.operations.push(`remove-legacy:${value.id}:${item?.id ?? "missing"}`);
  }
  async quarantineManagedWorkspace(value: ManagedWorkspaceHandle): Promise<void> { this.operations.push(`quarantine-managed:${value.id}`); }
  async removeManagedWorkspace(value: ManagedWorkspaceHandle, item?: Task): Promise<void> {
    this.operations.push(`remove-managed:${value.id}:${item?.id ?? "missing"}`);
  }
  async removeTerminalWorkspace(item: Task): Promise<void> { this.operations.push(`remove-terminal:${item.id}`); }
}

function inventory(completeness: "complete" | "partial"): ProviderTaskInventory {
  return Object.freeze({ completeness, entries: Object.freeze([
    Object.freeze({ task: current, lifecycle: "current" as const }),
    Object.freeze({ task: terminal, lifecycle: "terminal" as const }),
  ]) });
}

function workspaceInventory(): ExecutionWorkspaceInventory {
  return Object.freeze({
    legacy: Object.freeze([
      Object.freeze({ kind: "unique" as const, handle: handle("legacy-current"), taskId: "1" }),
      Object.freeze({ kind: "unique" as const, handle: handle("legacy-terminal"), taskId: "2" }),
      Object.freeze({ kind: "ambiguous" as const, handle: handle("legacy-ambiguous") }),
      Object.freeze({ kind: "unmatched" as const, handle: handle("legacy-missing") }),
    ]),
    managed: Object.freeze([
      Object.freeze({ kind: "unique" as const, handle: handle("managed-current"), taskId: "1" }),
      Object.freeze({ kind: "unique" as const, handle: handle("managed-terminal"), taskId: "2" }),
      Object.freeze({ kind: "unmatched" as const, handle: handle("managed-missing") }),
      Object.freeze({ kind: "invalid" as const, handle: handle("managed-invalid") }),
    ]),
  });
}

test("startup classifies and cleans workspaces before candidate configuration", async () => {
  const executions = new WorkspaceExecutions(workspaceInventory());
  const scheduler = new Scheduler(new InventoryProvider(inventory("complete")), executions);
  await scheduler.startup();
  assert.deepEqual(executions.operations, [
    "inspect", "migrate:legacy-current", "remove-legacy:legacy-terminal:2",
    "quarantine-legacy:legacy-ambiguous", "remove-legacy:legacy-missing:missing",
    "remove-managed:managed-terminal:2", "remove-managed:managed-missing:missing",
    "quarantine-managed:managed-invalid", "configure:1", "configure:2",
  ]);
});

test("partial inventory leaves absent workspaces untouched and still removes matched terminal work", async () => {
  const executions = new WorkspaceExecutions(workspaceInventory());
  await new Scheduler(new InventoryProvider(inventory("partial")), executions).startup();
  assert.ok(executions.operations.includes("remove-legacy:legacy-terminal:2"));
  assert.ok(executions.operations.includes("remove-managed:managed-terminal:2"));
  assert.ok(!executions.operations.some((entry) => entry.includes("legacy-missing")));
  assert.ok(!executions.operations.some((entry) => entry.includes("managed-missing")));
});

test("legacy removal never runs a repository hook through an escaping symlink", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-legacy-hook-"));
  const outside = await mkdtemp(join(tmpdir(), "ensemble-legacy-outside-"));
  const root = join(base, "2");
  await mkdir(root);
  await mkdir(join(root, ".ensemble-runtime"));
  await symlink(outside, join(root, "repository"));
  const manager = new LocalWorkspaceManager(base, { materialize: async () => undefined }, true, "cleanup:test");
  const [match] = await manager.classifyLegacy([terminal]);
  assert.equal(match?.kind, "unique");
  let invoked = false;
  await manager.removeLegacy(match!.handle, { beforeRemove: async (value) => {
    invoked = true;
    await writeFile(join(value.repositoryPath, "escaped"), "unsafe");
  } });
  assert.equal(invoked, false);
  await assert.rejects(readdir(root));
  assert.deepEqual(await readdir(outside), []);
});

test("managed inventory removal is opaque, hook-failure tolerant, and restart-idempotent", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-managed-inventory-"));
  const repositories: RepositoryDriver = {
    materialize: async (_repository, target) => { await mkdir(target); },
  };
  const creator = new LocalWorkspaceManager(base, repositories, true, "cleanup:test");
  await creator.create(current);
  await creator.create(terminal);
  await creator.create(task("3", "ready"));

  const manager = new LocalWorkspaceManager(base, repositories, true, "cleanup:test");
  const matches = await manager.classifyManaged([current, terminal]);
  const terminalMatch = matches.find((match) => match.kind === "unique" && match.taskId === "2");
  const missingMatch = matches.find((match) => match.kind === "unmatched");
  assert.ok(terminalMatch?.kind === "unique");
  assert.ok(missingMatch?.kind === "unmatched");
  let beforeRemove = 0;
  await manager.removeManaged(terminalMatch.handle, { beforeRemove: async () => { beforeRemove += 1; throw new Error("secondary"); } });
  await manager.removeManaged(missingMatch.handle);
  assert.equal(beforeRemove, 1);

  const reconstructed = new LocalWorkspaceManager(base, repositories, true, "cleanup:test");
  const remaining = await reconstructed.classifyManaged([current, terminal]);
  assert.deepEqual(remaining.map((match) => match.kind === "unique" ? match.taskId : match.kind), ["1"]);
});

test("a managed workspace with a missing manifest is quarantined rather than treated as legacy", async () => {
  const base = await mkdtemp(join(tmpdir(), "ensemble-invalid-managed-"));
  const repositories: RepositoryDriver = { materialize: async (_repository, target) => { await mkdir(target); } };
  const creator = new LocalWorkspaceManager(base, repositories, true, "cleanup:test");
  const created = await creator.create(current);
  await rm(join(created.runtimePath, "workspace.json"));
  const manager = new LocalWorkspaceManager(base, repositories, true, "cleanup:test");
  assert.deepEqual(await manager.classifyLegacy([current]), []);
  const [invalid] = await manager.classifyManaged([current]);
  assert.equal(invalid?.kind, "invalid");
  await manager.quarantineManaged(invalid!.handle);
  assert.ok((await readdir(base)).some((entry) => entry.startsWith(".ensemble-quarantine-")));
});

test("terminal completion synchronizes provider state before requesting forced workspace removal", async () => {
  class CompletingExecutions extends WorkspaceExecutions {
    override async withConfiguration<T>(item: Task, work: (execution: ConfiguredExecution) => Promise<T>): Promise<T> {
      const activeConfiguration = { ...configuration, concurrency: { global: 1, byStatus: {} } };
      return work({
        configuration: activeConfiguration,
        withEnvironment: async (environmentWork) => environmentWork({
          configuration: activeConfiguration,
          start: async (request) => ({
            executionId: request.executionId,
            startedAt: "2026-08-01T00:00:00.000Z",
            lastActivityAt: "2026-08-01T00:00:00.000Z",
            snapshot: () => ({ executionId: request.executionId, taskId: item.id, role: request.role.name,
              runtimeSessionId: "session", workspacePath: "/opaque", state: "completed" as const,
              startedAt: "2026-08-01T00:00:00.000Z", lastActivityAt: "2026-08-01T00:00:00.000Z" }),
            cancel: async () => undefined,
            result: Promise.resolve({ kind: "completed" as const, taskId: item.id, role: request.role.name,
              executionId: request.executionId, result: { outcome: "approved", summary: "done", comments: [], artifacts: [] } }),
          }),
        }),
      });
    }
  }
  const provider = new InventoryProvider(inventory("complete"));
  const executions = new CompletingExecutions(Object.freeze({ legacy: Object.freeze([]), managed: Object.freeze([]) }));
  const reports = await new Scheduler(provider, executions).poll();
  assert.equal(reports[0]?.outcome, "completed");
  assert.equal((await provider.getTask("1")).status, "completed");
  assert.deepEqual(executions.operations, ["inspect", "remove-terminal:1"]);
});
