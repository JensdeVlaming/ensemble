/** Runtime- and provider-neutral domain contracts. */
export type TaskId = string;

export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly status: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  /** Adapter-derived eligibility after provider-specific routing and blocker checks. */
  readonly dispatchable?: boolean;
  /** Portable priority where lower values are dispatched first. */
  readonly priority?: number;
  readonly blockers?: readonly TaskBlocker[];
  readonly repository: RepositoryRef;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskBlocker {
  readonly id: TaskId;
  readonly status?: string;
  readonly resolved: boolean;
}

export interface RepositoryRef {
  readonly id: string;
  readonly url: string;
  readonly defaultBranch?: string;
  readonly branch?: string;
}

export interface TaskComment {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly createdAt: string;
}

export interface Artifact {
  readonly type: string;
  readonly url: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Workspace {
  readonly root: string;
  readonly repositoryPath: string;
  readonly runtimePath: string;
}

export interface RoleDefinition {
  readonly name: string;
  readonly instructions: string;
}

export interface WorkflowDefinition {
  readonly instructions: string;
  readonly roles: readonly RoleDefinition[];
}

export interface RepositoryConfiguration {
  readonly repository: RepositoryRef;
  readonly workflow: WorkflowDefinition;
  readonly agents: string;
  readonly runtime: RuntimeSelection;
  readonly initialRole: string;
  readonly terminalOutcomes: readonly string[];
  readonly runnableStatuses: readonly string[];
  readonly runningStatus: string;
  readonly completedStatus: string;
  readonly failedStatus: string;
  readonly retry: RetryPolicy;
}

export interface RetryPolicy {
  /** Maximum failed executions retained per role before further retries stop. */
  readonly maxFailedAttemptsPerRole: number;
}

export interface RuntimeSelection {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RuntimeContext {
  readonly repository: RepositoryRef;
  readonly workspace: Workspace;
  readonly task: Task;
  readonly comments: readonly TaskComment[];
  readonly artifacts: readonly Artifact[];
  readonly workflow: WorkflowDefinition;
  readonly agents: string;
  readonly role: RoleDefinition;
  readonly runtimeConfig: Readonly<Record<string, unknown>>;
}

export interface ResumeContext {
  readonly reason: string;
  readonly comments: readonly TaskComment[];
  readonly artifacts: readonly Artifact[];
}

export interface RuntimeResult {
  readonly outcome: string;
  readonly summary: string;
  readonly nextRole?: string;
  readonly comments: readonly string[];
  readonly artifacts: readonly Artifact[];
}
