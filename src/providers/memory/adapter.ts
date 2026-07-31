import type { Artifact, Task, TaskComment, TaskId } from "../../domain/model.ts";
import type {
  ActiveExecution,
  ExecutionCompletion,
  ExecutionRecord,
  ProviderAdapter,
  ProviderExecutionState,
  TaskQuery,
} from "../provider.ts";

/** Reference adapter used by tests and local experiments. */
export class InMemoryProvider implements ProviderAdapter {
  readonly name = "memory";
  readonly #tasks = new Map<TaskId, Task>();
  readonly #comments = new Map<TaskId, TaskComment[]>();
  readonly #artifacts = new Map<TaskId, Artifact[]>();
  readonly #isWorkflowCandidate: (task: Task) => boolean;

  constructor(tasks: readonly Task[] = [], isWorkflowCandidate: (task: Task) => boolean = () => true) {
    for (const task of tasks) this.#tasks.set(task.id, task);
    this.#isWorkflowCandidate = isWorkflowCandidate;
  }

  async discoverTasks(query: TaskQuery): Promise<readonly Task[]> {
    if (query.scope !== "workflow_candidates") throw new Error(`Unsupported task query scope: ${String(query.scope)}`);
    return [...this.#tasks.values()].filter(this.#isWorkflowCandidate);
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
      history: Object.freeze(history.map((record) => Object.freeze({ ...record }))),
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

  async beginExecution(id: TaskId, role: string, runningStatus: string): Promise<ActiveExecution> {
    const task = await this.getTask(id);
    const existing = task.metadata?.activeExecution;
    if (isActiveExecution(existing)) return existing;
    const history = Array.isArray(task.metadata?.executionHistory) ? task.metadata.executionHistory : [];
    const execution = { id: `${id}:${history.length + 1}`, role, startedAt: new Date().toISOString() };
    this.#tasks.set(id, { ...task, status: runningStatus, metadata: { ...task.metadata, activeExecution: execution } });
    return execution;
  }

  async completeExecution(id: TaskId, executionId: string, completion: ExecutionCompletion): Promise<void> {
    const task = await this.getTask(id);
    if (hasExecution(task, executionId)) return;
    const active = task.metadata?.activeExecution;
    if (!isActiveExecution(active) || active.id !== executionId) throw new Error(`Execution is not active: ${executionId}`);
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

  async failExecution(id: TaskId, executionId: string, record: ExecutionRecord, status: string, comment: string): Promise<void> {
    await this.completeExecution(id, executionId, { record, comments: [comment], artifacts: [], status });
  }
}

function isActiveExecution(value: unknown): value is ActiveExecution {
  return !!value && typeof value === "object" && typeof (value as ActiveExecution).id === "string"
    && typeof (value as ActiveExecution).role === "string" && typeof (value as ActiveExecution).startedAt === "string";
}

function validateActiveExecution(value: unknown): ActiveExecution {
  if (!isActiveExecution(value)) throw new Error("Invalid active execution state");
  return value;
}

function validateExecutionRecord(value: unknown): ExecutionRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid execution record");
  const record = value as Partial<ExecutionRecord>;
  if (typeof record.id !== "string" || typeof record.role !== "string" || typeof record.outcome !== "string"
    || typeof record.summary !== "string" || typeof record.finishedAt !== "string"
    || (record.nextRole !== undefined && typeof record.nextRole !== "string")) throw new Error("Invalid execution record");
  return record as ExecutionRecord;
}

function compareExecutionRecords(left: ExecutionRecord, right: ExecutionRecord): number {
  return left.finishedAt.localeCompare(right.finishedAt) || left.id.localeCompare(right.id);
}

function hasExecution(task: Task, id: string): boolean {
  return Array.isArray(task.metadata?.executionHistory)
    && task.metadata.executionHistory.some((item) => !!item && typeof item === "object" && (item as { id?: unknown }).id === id);
}
