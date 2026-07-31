import type { Artifact, Task, TaskComment, TaskId } from "../domain/model.ts";

export interface TaskQuery {
  /** Provider adapters map their own assignment/archive/terminal concepts here. */
  readonly scope: "workflow_candidates";
}

export interface ExecutionRecord {
  readonly id: string;
  readonly role: string;
  readonly outcome: string;
  readonly summary: string;
  readonly nextRole?: string;
  readonly finishedAt: string;
  readonly failure?: FailureDetail;
  readonly blockingRequest?: BlockingRequest;
}

export type FailureKind = "startup" | "provider" | "configuration" | "runtime" | "timeout" | "stalled" | "reconciliation" | "shutdown";

export interface FailureDetail {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly nextAttemptAt?: string;
}

export interface BlockingRequest {
  readonly kind: "approval" | "user_input" | "tool_elicitation";
  readonly summary: string;
  readonly requestId?: string;
  readonly createdAt: string;
}

export interface ActiveExecution {
  readonly id: string;
  readonly role: string;
  readonly startedAt: string;
}

export interface ProviderExecutionState {
  readonly active?: ActiveExecution;
  readonly history: readonly ExecutionRecord[];
  readonly nextRole?: string;
}

export interface ExecutionCompletion {
  readonly record: ExecutionRecord;
  readonly comments: readonly string[];
  readonly artifacts: readonly Artifact[];
  readonly status: string;
}

export type TaskRefreshResult =
  | { readonly kind: "current"; readonly task: Task }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: string };

export interface ExecutionCancellation {
  readonly record: ExecutionRecord;
  readonly status: string;
  readonly comment: string;
}

export class ProviderClaimConflict extends Error {
  readonly taskId: TaskId;
  readonly activeExecution: ActiveExecution;

  constructor(taskId: TaskId, activeExecution: ActiveExecution) {
    super(`Task ${taskId} is already claimed by execution ${activeExecution.id}`);
    this.name = "ProviderClaimConflict";
    this.taskId = taskId;
    this.activeExecution = activeExecution;
  }
}

export interface ProviderAdapter {
  readonly name: string;
  discoverTasks(query: TaskQuery): Promise<readonly Task[]>;
  refreshTasks(ids: readonly TaskId[]): Promise<ReadonlyMap<TaskId, TaskRefreshResult>>;
  getTask(id: TaskId): Promise<Task>;
  getComments(id: TaskId): Promise<readonly TaskComment[]>;
  getArtifacts(id: TaskId): Promise<readonly Artifact[]>;
  getExecutionState(id: TaskId): Promise<ProviderExecutionState>;
  updateStatus(id: TaskId, status: string): Promise<void>;
  createComment(id: TaskId, body: string): Promise<TaskComment>;
  uploadArtifact(id: TaskId, artifact: Artifact): Promise<Artifact>;
  /** Atomically creates, or returns, the durable active execution marker. */
  beginExecution(id: TaskId, role: string, runningStatus: string): Promise<ActiveExecution>;
  /** Atomically and idempotently applies every result side effect. */
  completeExecution(id: TaskId, executionId: string, completion: ExecutionCompletion): Promise<void>;
  /** Atomically and idempotently records a failed execution. */
  failExecution(id: TaskId, executionId: string, record: ExecutionRecord, status: string, comment: string): Promise<void>;
  /** Atomically and idempotently records a reconciliation or shutdown cancellation. */
  cancelExecution(id: TaskId, executionId: string, cancellation: ExecutionCancellation): Promise<void>;
  /** Atomically and idempotently records work that requires operator action. */
  blockExecution(id: TaskId, executionId: string, cancellation: ExecutionCancellation): Promise<void>;
}
