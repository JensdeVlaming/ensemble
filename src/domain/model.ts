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
  readonly blockedStatus: string;
  readonly service: ServicePolicy;
  readonly concurrency: ConcurrencyPolicy;
  readonly retry: RetryPolicy;
  readonly timeouts: TimeoutPolicy;
  readonly shutdown: ShutdownPolicy;
  readonly workspace: WorkspacePolicy;
}

export interface ServicePolicy {
  readonly pollIntervalMs: number;
}

export interface ConcurrencyPolicy {
  readonly global: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

export type FailureKind =
  | "startup"
  | "provider"
  | "configuration"
  | "runtime"
  | "timeout"
  | "stalled"
  | "reconciliation"
  | "shutdown";

export interface RetryPolicy {
  /** Maximum failed executions retained per role before further retries stop. */
  readonly maxFailedAttemptsPerRole: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
  readonly retryableFailureKinds: readonly FailureKind[];
}

export interface TimeoutPolicy {
  readonly startupMs: number;
  readonly providerMs: number;
  readonly runtimeStartMs: number;
  readonly turnMs: number;
  readonly stallMs: number;
  readonly cancellationMs: number;
}

export interface ShutdownPolicy {
  readonly drainTimeoutMs: number;
}

export interface WorkspaceHook {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface WorkspaceHooks {
  readonly afterCreate?: WorkspaceHook;
  readonly beforeRun?: WorkspaceHook;
  readonly afterRun?: WorkspaceHook;
  readonly beforeRemove?: WorkspaceHook;
}

export interface WorkspacePolicy {
  readonly hooks: WorkspaceHooks;
  readonly hookTimeoutMs: number;
}

export interface RuntimeSelection {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export type PortableJsonValue = null | boolean | number | string
  | readonly PortableJsonValue[] | { readonly [key: string]: PortableJsonValue };

export interface RuntimeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, PortableJsonValue>>;
  invoke(input: unknown, context?: RuntimeToolInvocationContext): Promise<PortableJsonValue>;
}

export interface RuntimeToolInvocationContext {
  readonly signal: AbortSignal;
}

export interface BlockingRequest {
  readonly kind: "approval" | "user_input" | "tool_elicitation";
  readonly summary: string;
  readonly requestId?: string;
  readonly createdAt: string;
}

export interface RuntimeContext {
  readonly executionId: string;
  readonly repository: RepositoryRef;
  readonly workspace: Workspace;
  readonly task: Task;
  readonly comments: readonly TaskComment[];
  readonly artifacts: readonly Artifact[];
  readonly workflow: WorkflowDefinition;
  readonly agents: string;
  readonly role: RoleDefinition;
  readonly runtimeConfig: Readonly<Record<string, unknown>>;
  readonly tools: readonly RuntimeTool[];
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
