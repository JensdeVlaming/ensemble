import type { Artifact, FailureKind, RuntimeTool, Task, TaskComment, TaskId } from "../../domain/model.ts";
import type {
  ActiveExecution,
  ExecutionLeaseBasis,
  ExecutionLeaseClaim,
  ExecutionLeaseGuard,
  ExecutionCompletion,
  ExecutionRecord,
  ExecutionCancellation,
  ProviderAdapter,
  ProviderExecutionState,
  ProviderTaskInventory,
  TaskQuery,
  TaskRefreshResult,
} from "../provider.ts";
import { ProviderClaimConflict } from "../provider.ts";

const failureKinds = new Set<FailureKind>([
  "startup", "provider", "configuration", "runtime", "timeout", "stalled", "reconciliation", "shutdown",
]);

/** Reference adapter used by tests and local experiments. */
export class InMemoryProvider implements ProviderAdapter {
  readonly name = "memory";
  readonly #tasks = new Map<TaskId, Task>();
  readonly #comments = new Map<TaskId, TaskComment[]>();
  readonly #artifacts = new Map<TaskId, Artifact[]>();
  readonly #isWorkflowCandidate: (task: Task) => boolean;
  readonly #now: () => Date;
  readonly #executionId?: (taskId: string, historyLength: number) => string;

  constructor(
    tasks: readonly Task[] = [],
    isWorkflowCandidate: (task: Task) => boolean = () => true,
    options: { readonly now?: () => Date; readonly executionId?: (taskId: string, historyLength: number) => string } = {},
  ) {
    for (const task of tasks) this.#tasks.set(task.id, task);
    this.#isWorkflowCandidate = isWorkflowCandidate;
    this.#now = options.now ?? (() => new Date());
    this.#executionId = options.executionId;
  }

  async discoverTasks(query: TaskQuery): Promise<readonly Task[]> {
    if (query.scope !== "workflow_candidates") throw new Error(`Unsupported task query scope: ${String(query.scope)}`);
    return [...this.#tasks.values()].filter(this.#isWorkflowCandidate);
  }

  async inventoryTasks(): Promise<ProviderTaskInventory> {
    return Object.freeze({
      completeness: "complete",
      entries: Object.freeze([...this.#tasks.values()].sort((left, right) => left.id.localeCompare(right.id)).map((task) =>
        Object.freeze({ task: Object.freeze({ ...task }), lifecycle: task.status === "completed" ? "terminal" as const : "current" as const }))),
    });
  }

  async refreshTasks(ids: readonly TaskId[]): Promise<ReadonlyMap<TaskId, TaskRefreshResult>> {
    const refreshed = new Map<TaskId, TaskRefreshResult>();
    for (const id of ids) {
      const task = this.#tasks.get(id);
      refreshed.set(id, task ? { kind: "current", task: { ...task } } : { kind: "missing" });
    }
    return refreshed;
  }

  async getTask(id: TaskId): Promise<Task> {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  async getComments(id: TaskId): Promise<readonly TaskComment[]> {
    await this.getTask(id);
    return [...(this.#comments.get(id) ?? [])];
  }

  async getArtifacts(id: TaskId): Promise<readonly Artifact[]> {
    await this.getTask(id);
    return [...(this.#artifacts.get(id) ?? [])];
  }

  async getRuntimeTools(id: TaskId, executionId: string, ownerId: string): Promise<readonly RuntimeTool[]> {
    const state = await this.getExecutionState(id);
    if (state.active?.id !== executionId || state.active.ownerId !== ownerId) throw new Error(`Execution is not active: ${executionId}`);
    return Object.freeze([]);
  }

  async getExecutionState(id: TaskId): Promise<ProviderExecutionState> {
    const task = await this.getTask(id);
    const activeValue = task.metadata?.activeExecution;
    const active = activeValue === undefined ? undefined : validateActiveExecution(activeValue);
    const historyValue = task.metadata?.executionHistory ?? [];
    if (!Array.isArray(historyValue)) throw new Error(`Invalid execution history for task ${id}`);
    const history = historyValue.map(validateExecutionRecord).sort(compareExecutionRecords);
    const nextRoleValue = task.metadata?.nextRole;
    if (nextRoleValue !== undefined && typeof nextRoleValue !== "string") throw new Error(`Invalid next role for task ${id}`);
    return Object.freeze({
      active: active && Object.freeze({ ...active }),
      history: Object.freeze(history.map(freezeExecutionRecord)),
      nextRole: nextRoleValue,
    });
  }

  async updateStatus(id: TaskId, status: string): Promise<void> {
    const task = await this.getTask(id);
    this.#tasks.set(id, { ...task, status });
  }

  async createComment(id: TaskId, body: string): Promise<TaskComment> {
    await this.getTask(id);
    const comments = this.#comments.get(id) ?? [];
    const comment = { id: `${id}-comment-${comments.length + 1}`, body, createdAt: new Date().toISOString() };
    comments.push(comment);
    this.#comments.set(id, comments);
    return comment;
  }

  async uploadArtifact(id: TaskId, artifact: Artifact): Promise<Artifact> {
    await this.getTask(id);
    const artifacts = this.#artifacts.get(id) ?? [];
    artifacts.push(artifact);
    this.#artifacts.set(id, artifacts);
    return artifact;
  }

  async beginExecution(id: TaskId, role: string, runningStatus: string, lease: ExecutionLeaseClaim): Promise<ActiveExecution> {
    const task = await this.getTask(id);
    validateLeaseClaim(lease);
    const existingValue = task.metadata?.activeExecution;
    const existing = existingValue === undefined ? undefined : validateActiveExecution(existingValue);
    assertLeaseBasis(id, lease.expected, existing);
    if (existing?.ownerId && existing.leaseExpiresAt
      && existing.ownerId !== lease.ownerId && Date.parse(existing.leaseExpiresAt) > Date.parse(lease.observedAt)) {
      throw new ProviderClaimConflict(id, existing);
    }
    const history = Array.isArray(task.metadata?.executionHistory) ? task.metadata.executionHistory : [];
    const execution = existing ? {
      ...existing,
      ownerId: lease.ownerId,
      leaseExpiresAt: lease.expiresAt,
    } : {
      id: this.#executionId?.(id, history.length) ?? `${id}:${history.length + 1}`,
      role,
      startedAt: this.#now().toISOString(),
      ownerId: lease.ownerId,
      leaseExpiresAt: lease.expiresAt,
    };
    this.#tasks.set(id, { ...task, status: runningStatus, metadata: { ...task.metadata, activeExecution: execution } });
    return Object.freeze({ ...execution });
  }

  async renewExecutionLease(id: TaskId, executionId: string, lease: ExecutionLeaseClaim): Promise<ActiveExecution> {
    const task = await this.getTask(id);
    validateLeaseClaim(lease);
    const existingValue = task.metadata?.activeExecution;
    const existing = existingValue === undefined ? undefined : validateActiveExecution(existingValue);
    assertLeaseBasis(id, lease.expected, existing);
    if (!existing || existing.id !== executionId || !existing.ownerId || !existing.leaseExpiresAt
      || existing.ownerId !== lease.ownerId || Date.parse(existing.leaseExpiresAt) <= Date.parse(lease.observedAt)
      || Date.parse(lease.expiresAt) <= Date.parse(existing.leaseExpiresAt)) {
      if (existing) throw new ProviderClaimConflict(id, existing);
      throw new Error(`Execution is not active: ${executionId}`);
    }
    const renewed = { ...existing, leaseExpiresAt: lease.expiresAt };
    this.#tasks.set(id, { ...task, metadata: { ...task.metadata, activeExecution: renewed } });
    return Object.freeze(renewed);
  }

  async completeExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, completion: ExecutionCompletion): Promise<void> {
    const task = await this.getTask(id);
    const recorded = findExecution(task, executionId);
    if (recorded) {
      if (!sameRecord(recorded, completion.record)) throw new Error(`Conflicting execution record: ${executionId}`);
      return;
    }
    const active = task.metadata?.activeExecution;
    if (!isActiveExecution(active) || active.id !== executionId) throw new Error(`Execution is not active: ${executionId}`);
    assertLeaseGuard(id, active, lease);
    const comments = this.#comments.get(id) ?? [];
    for (const body of completion.comments) comments.push({ id: `${id}-comment-${comments.length + 1}`, body, createdAt: new Date().toISOString() });
    this.#comments.set(id, comments);
    const artifacts = this.#artifacts.get(id) ?? [];
    artifacts.push(...completion.artifacts);
    this.#artifacts.set(id, artifacts);
    const history = Array.isArray(task.metadata?.executionHistory) ? [...task.metadata.executionHistory] : [];
    history.push(completion.record);
    const { activeExecution: _active, ...metadata } = task.metadata ?? {};
    this.#tasks.set(id, { ...task, status: completion.status, metadata: { ...metadata,
      nextRole: completion.record.nextRole, executionHistory: history } });
  }

  async failExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, record: ExecutionRecord, status: string, comment: string): Promise<void> {
    await this.completeExecution(id, executionId, lease, { record, comments: [comment], artifacts: [], status });
  }

  async cancelExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, cancellation: ExecutionCancellation): Promise<void> {
    await this.completeExecution(id, executionId, lease, {
      record: cancellation.record, comments: [cancellation.comment], artifacts: [], status: cancellation.status,
    });
  }

  async blockExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, cancellation: ExecutionCancellation): Promise<void> {
    await this.cancelExecution(id, executionId, lease, cancellation);
  }
}

function isActiveExecution(value: unknown): value is ActiveExecution {
  return !!value && typeof value === "object" && typeof (value as ActiveExecution).id === "string"
    && typeof (value as ActiveExecution).role === "string" && typeof (value as ActiveExecution).startedAt === "string"
    && (((value as ActiveExecution).ownerId === undefined && (value as ActiveExecution).leaseExpiresAt === undefined)
      || (typeof (value as ActiveExecution).ownerId === "string" && !!(value as ActiveExecution).ownerId
        && isCanonicalTimestamp((value as ActiveExecution).leaseExpiresAt)));
}

function validateActiveExecution(value: unknown): ActiveExecution {
  if (!isActiveExecution(value)) throw new Error("Invalid active execution state");
  return value;
}

function validateExecutionRecord(value: unknown): ExecutionRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid execution record");
  const record = value as Partial<ExecutionRecord>;
  const blockingRequest = record.blockingRequest === undefined ? undefined : normalizeBlockingRequest(record.blockingRequest);
  if (typeof record.id !== "string" || typeof record.role !== "string" || typeof record.outcome !== "string"
    || typeof record.summary !== "string" || typeof record.finishedAt !== "string" || Number.isNaN(Date.parse(record.finishedAt))
    || (record.nextRole !== undefined && typeof record.nextRole !== "string")
    || (record.failure !== undefined && !isValidFailure(record.failure))
    || (record.outcome === "blocked") !== (blockingRequest !== undefined)) {
    throw new Error("Invalid execution record");
  }
  return { ...record, ...(blockingRequest === undefined ? {} : { blockingRequest }) } as ExecutionRecord;
}

function normalizeBlockingRequest(value: unknown): NonNullable<ExecutionRecord["blockingRequest"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Invalid blocking request");
  }
  const request = value as Partial<NonNullable<ExecutionRecord["blockingRequest"]>>;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["kind", "summary", "requestId", "createdAt"].includes(key))
    || (request.kind !== "approval" && request.kind !== "user_input" && request.kind !== "tool_elicitation")
    || typeof request.summary !== "string" || request.summary.trim().length === 0
    || Buffer.byteLength(request.summary, "utf8") > 2_048 || !isCanonicalTimestamp(request.createdAt)
    || (request.requestId !== undefined && (typeof request.requestId !== "string" || request.requestId.trim().length === 0
      || Buffer.byteLength(request.requestId, "utf8") > 256))) throw new Error("Invalid blocking request");
  return Object.freeze({ kind: request.kind, summary: request.summary,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }), createdAt: request.createdAt });
}

function isValidFailure(failure: NonNullable<ExecutionRecord["failure"]>): boolean {
  if (!failure || !failureKinds.has(failure.kind) || typeof failure.retryable !== "boolean") return false;
  if (!failure.retryable) return failure.nextAttemptAt === undefined;
  return isCanonicalTimestamp(failure.nextAttemptAt);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function freezeExecutionRecord(record: ExecutionRecord): ExecutionRecord {
  return Object.freeze({
    ...record,
    failure: record.failure && Object.freeze({ ...record.failure }),
    blockingRequest: record.blockingRequest && Object.freeze({ ...record.blockingRequest }),
  });
}

function compareExecutionRecords(left: ExecutionRecord, right: ExecutionRecord): number {
  return left.finishedAt.localeCompare(right.finishedAt) || left.id.localeCompare(right.id);
}

function findExecution(task: Task, id: string): ExecutionRecord | undefined {
  if (!Array.isArray(task.metadata?.executionHistory)) return undefined;
  const value = task.metadata.executionHistory.find((item) => !!item && typeof item === "object" && (item as { id?: unknown }).id === id);
  return value === undefined ? undefined : validateExecutionRecord(value);
}

function validateLeaseClaim(lease: ExecutionLeaseClaim): void {
  if (!lease.ownerId.trim() || !isCanonicalTimestamp(lease.observedAt) || !isCanonicalTimestamp(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= Date.parse(lease.observedAt)) throw new Error("Invalid execution lease claim");
}

function assertLeaseBasis(taskId: string, basis: ExecutionLeaseBasis, active: ActiveExecution | undefined): void {
  const matches = basis.kind === "none"
    ? active === undefined
    : active !== undefined && basis.executionId === active.id && basis.role === active.role && basis.startedAt === active.startedAt
      && (basis.kind === "legacy"
        ? active.ownerId === undefined && active.leaseExpiresAt === undefined
        : basis.ownerId === active.ownerId && basis.leaseExpiresAt === active.leaseExpiresAt);
  if (matches) return;
  if (active) throw new ProviderClaimConflict(taskId, active);
  throw new Error(`Execution lease basis no longer exists for task ${taskId}`);
}

function assertLeaseGuard(taskId: string, active: ActiveExecution, guard: ExecutionLeaseGuard): void {
  if (!guard.ownerId.trim() || !isCanonicalTimestamp(guard.observedAt) || !isCanonicalTimestamp(guard.leaseExpiresAt)
    || active.ownerId !== guard.ownerId || active.leaseExpiresAt !== guard.leaseExpiresAt
    || Date.parse(guard.leaseExpiresAt) <= Date.parse(guard.observedAt)) throw new ProviderClaimConflict(taskId, active);
}

function sameRecord(left: ExecutionRecord, right: ExecutionRecord): boolean {
  return left.id === right.id && left.role === right.role && left.outcome === right.outcome
    && left.summary === right.summary && left.nextRole === right.nextRole && left.finishedAt === right.finishedAt
    && JSON.stringify(left.failure) === JSON.stringify(right.failure)
    && JSON.stringify(left.blockingRequest) === JSON.stringify(right.blockingRequest);
}
