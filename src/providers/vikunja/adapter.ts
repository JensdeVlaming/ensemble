import { randomUUID } from "node:crypto";
import type { Artifact, FailureKind, RepositoryRef, Task, TaskBlocker, TaskComment, TaskId } from "../../domain/model.ts";
import type {
  ActiveExecution,
  ExecutionCancellation,
  ExecutionCompletion,
  ExecutionLeaseBasis,
  ExecutionLeaseClaim,
  ExecutionLeaseGuard,
  ExecutionRecord,
  ProviderAdapter,
  ProviderExecutionState,
  TaskQuery,
  TaskRefreshResult,
} from "../provider.ts";
import { ProviderClaimConflict } from "../provider.ts";
import { VikunjaApiError, VikunjaClient } from "./client.ts";
import type { VikunjaClientOptions } from "./client.ts";

const STATE_PREFIX = "<!-- ensemble-provider-state:v1\n";
const STATE_SUFFIX = "\n-->";
const SIDE_EFFECT_PREFIX = "<!-- ensemble-side-effect:";
const failureKinds = new Set<FailureKind>([
  "startup", "provider", "configuration", "runtime", "timeout", "stalled", "reconciliation", "shutdown",
]);

export interface VikunjaStatusLabels {
  readonly ready: string;
  readonly running: string;
  readonly blocked: string;
  readonly failed: string;
  readonly completed: string;
}

export interface VikunjaProviderOptions extends VikunjaClientOptions {
  readonly projectId: number;
  readonly viewId: number;
  readonly repository: RepositoryRef;
  readonly requiredAssignee?: string;
  readonly requiredLabels?: readonly string[];
  readonly statusLabels?: Partial<VikunjaStatusLabels>;
  readonly executionId?: () => string;
  readonly now?: () => Date;
}

interface VikunjaUser {
  readonly id?: number;
  readonly username?: string;
}

interface VikunjaLabel {
  readonly id?: number;
  readonly title?: string;
}

interface VikunjaTask {
  readonly id?: number;
  readonly identifier?: string;
  readonly title?: string;
  readonly description?: string;
  readonly done?: boolean;
  readonly priority?: number;
  readonly project_id?: number;
  readonly labels?: readonly VikunjaLabel[];
  readonly assignees?: readonly VikunjaUser[];
  readonly related_tasks?: Readonly<Record<string, readonly VikunjaTask[]>>;
}

interface VikunjaProject {
  readonly id?: number;
  readonly title?: string;
  readonly is_archived?: boolean;
}

interface VikunjaView {
  readonly id?: number;
  readonly title?: string;
  readonly view_kind?: string;
}

interface VikunjaComment {
  readonly id?: number;
  readonly comment?: string;
  readonly created?: string;
  readonly author?: VikunjaUser;
}

interface ProviderEvent {
  readonly protocol: "ensemble-provider-state/v1";
  readonly kind: "claim" | "lease" | "complete" | "fail" | "cancel" | "block" | "artifact";
  readonly executionId: string;
  readonly role?: string;
  readonly basis?: string;
  readonly expected?: ExecutionLeaseBasis;
  readonly ownerId?: string;
  readonly leaseExpiresAt?: string;
  readonly observedAt?: string;
  readonly createdAt: string;
  readonly record?: ExecutionRecord;
  readonly artifacts?: readonly Artifact[];
}

interface ParsedEvent {
  readonly event: ProviderEvent;
  readonly commentId: number;
  readonly createdAt: string;
}

const DEFAULT_STATUS_LABELS: VikunjaStatusLabels = {
  ready: "ensemble:ready",
  running: "ensemble:running",
  blocked: "ensemble:blocked",
  failed: "ensemble:failed",
  completed: "ensemble:completed",
};

/** Vikunja API v1 adapter with provider-owned execution journals in task comments. */
export class VikunjaProvider implements ProviderAdapter {
  readonly name = "vikunja";
  readonly client: VikunjaClient;
  readonly projectId: number;
  readonly viewId: number;
  readonly repository: RepositoryRef;
  readonly requiredAssignee?: string;
  readonly requiredLabels: readonly string[];
  readonly statusLabels: VikunjaStatusLabels;
  readonly #executionId: () => string;
  readonly #now: () => Date;
  #labelIds?: ReadonlyMap<string, number>;

  constructor(options: VikunjaProviderOptions) {
    this.client = new VikunjaClient(options);
    this.projectId = positiveInteger(options.projectId, "projectId");
    this.viewId = positiveInteger(options.viewId, "viewId");
    this.repository = Object.freeze({ ...options.repository });
    this.requiredAssignee = options.requiredAssignee;
    this.requiredLabels = Object.freeze([...(options.requiredLabels ?? [])]);
    this.statusLabels = Object.freeze({ ...DEFAULT_STATUS_LABELS, ...options.statusLabels });
    assertDistinctStatuses(this.statusLabels);
    this.#executionId = options.executionId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async validateConfiguration(): Promise<void> {
    const project = await this.client.request<VikunjaProject>("GET", `projects/${this.projectId}`);
    if (requiredNumber(project.id, "project id") !== this.projectId) throw new Error("Vikunja returned a different project");
    if (project.is_archived) throw new Error(`Vikunja project is archived: ${requiredString(project.title, "project title")}`);
    const views = await this.client.request<unknown>("GET", `projects/${this.projectId}/views`);
    if (!Array.isArray(views)) throw new Error("Vikunja project views response is not an array");
    const selected = views.map(validateView).find((view) => view.id === this.viewId);
    if (!selected) throw new Error(`Vikunja project view does not exist: ${this.viewId}`);
    if (selected.view_kind === "kanban") throw new Error("Vikunja discovery view must return a task list, not Kanban buckets");
    await this.#statusLabelIds();
  }

  async discoverTasks(query: TaskQuery): Promise<readonly Task[]> {
    if (query.scope !== "workflow_candidates") throw new Error(`Unsupported task query scope: ${String(query.scope)}`);
    const raw = await this.client.paginate<VikunjaTask>(`projects/${this.projectId}/views/${this.viewId}/tasks`, {
      sort_by: "priority", order_by: "desc", expand: "buckets",
    });
    return raw.map((task) => this.#normalizeTask(task)).filter((task) =>
      task.status === "running" || (task.dispatchable === true && (task.status === "ready" || task.status === "failed")));
  }

  async refreshTasks(ids: readonly TaskId[]): Promise<ReadonlyMap<TaskId, TaskRefreshResult>> {
    const results = new Map<TaskId, TaskRefreshResult>();
    await Promise.all(ids.map(async (id) => {
      try {
        results.set(id, { kind: "current", task: await this.getTask(id) });
      } catch (error) {
        if (error instanceof VikunjaApiError && error.status === 404) results.set(id, { kind: "missing" });
        else results.set(id, { kind: "unreadable", error: errorMessage(error) });
      }
    }));
    return new Map([...results].sort(([left], [right]) => left.localeCompare(right)));
  }

  async getTask(id: TaskId): Promise<Task> {
    return this.#normalizeTask(await this.client.request<VikunjaTask>("GET", `tasks/${taskNumber(id)}?expand=buckets`));
  }

  async getComments(id: TaskId): Promise<readonly TaskComment[]> {
    const comments = await this.#comments(id);
    return comments.flatMap((comment): TaskComment[] => {
      const body = requiredString(comment.comment, "comment");
      if (body.startsWith(STATE_PREFIX)) return [];
      return [{
        id: String(requiredNumber(comment.id, "comment id")),
        body: stripSideEffectMarker(body),
        author: comment.author?.username,
        createdAt: requiredDate(comment.created, "comment created"),
      }];
    });
  }

  async getArtifacts(id: TaskId): Promise<readonly Artifact[]> {
    const events = parseEvents(await this.#comments(id));
    const artifacts = events.flatMap(({ event }) => event.artifacts ?? []);
    return Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact })));
  }

  async getExecutionState(id: TaskId): Promise<ProviderExecutionState> {
    return stateFromEvents(parseEvents(await this.#comments(id)));
  }

  async updateStatus(id: TaskId, status: string): Promise<void> {
    const task = await this.client.request<VikunjaTask>("GET", `tasks/${taskNumber(id)}`);
    const labels = task.labels ?? [];
    const labelIds = await this.#statusLabelIds();
    const target = labelIds.get(status);
    if (target === undefined) throw new Error(`Unsupported Vikunja portable status: ${status}`);
    const statusIds = new Set(labelIds.values());
    const preserved = labels.map((label) => requiredNumber(label.id, "label id")).filter((labelId) => !statusIds.has(labelId));
    await this.client.request("POST", `tasks/${taskNumber(id)}/labels/bulk`, {
      labels: [...preserved, target].map((id) => ({ id })),
    });
    const done = status === "completed";
    if (Boolean(task.done) !== done) await this.client.request("POST", `tasks/${taskNumber(id)}`, { done });
  }

  async createComment(id: TaskId, body: string): Promise<TaskComment> {
    const comment = await this.#createRawComment(id, body);
    return {
      id: String(requiredNumber(comment.id, "comment id")), body,
      author: comment.author?.username, createdAt: requiredDate(comment.created, "comment created"),
    };
  }

  async uploadArtifact(id: TaskId, artifact: Artifact): Promise<Artifact> {
    await this.#appendEvent(id, {
      protocol: "ensemble-provider-state/v1", kind: "artifact", executionId: `artifact:${this.#executionId()}`,
      createdAt: this.#now().toISOString(), artifacts: [artifact],
    });
    return Object.freeze({ ...artifact });
  }

  async beginExecution(id: TaskId, role: string, runningStatus: string, lease: ExecutionLeaseClaim): Promise<ActiveExecution> {
    validateLeaseClaim(lease);
    const initialEvents = parseEvents(await this.#comments(id));
    const initial = stateFromEvents(initialEvents);
    assertLeaseBasis(id, lease.expected, initial.active);
    if (initial.active?.ownerId && initial.active.leaseExpiresAt && initial.active.ownerId !== lease.ownerId
      && Date.parse(initial.active.leaseExpiresAt) > Date.parse(lease.observedAt)) throw new ProviderClaimConflict(id, initial.active);
    const executionId = initial.active?.id ?? this.#executionId();
    const startedAt = this.#now().toISOString();
    await this.#appendEvent(id, {
      protocol: "ensemble-provider-state/v1", kind: "claim", executionId,
      role: initial.active?.role ?? role, expected: lease.expected, ownerId: lease.ownerId,
      leaseExpiresAt: lease.expiresAt, observedAt: lease.observedAt, createdAt: startedAt,
    });
    const state = stateFromEvents(parseEvents(await this.#comments(id)));
    if (!state.active || state.active.id !== executionId || state.active.ownerId !== lease.ownerId
      || state.active.leaseExpiresAt !== lease.expiresAt) {
      if (state.active) throw new ProviderClaimConflict(id, state.active);
      throw new Error(`Vikunja claim ${executionId} was not durable`);
    }
    await this.updateStatus(id, runningStatus);
    return state.active;
  }

  async renewExecutionLease(id: TaskId, executionId: string, lease: ExecutionLeaseClaim): Promise<ActiveExecution> {
    validateLeaseClaim(lease);
    const before = stateFromEvents(parseEvents(await this.#comments(id)));
    assertLeaseBasis(id, lease.expected, before.active);
    if (!before.active || before.active.id !== executionId || before.active.ownerId !== lease.ownerId
      || !before.active.leaseExpiresAt || Date.parse(before.active.leaseExpiresAt) <= Date.parse(lease.observedAt)
      || Date.parse(lease.expiresAt) <= Date.parse(before.active.leaseExpiresAt)) {
      if (before.active) throw new ProviderClaimConflict(id, before.active);
      throw new Error(`Execution is not active: ${executionId}`);
    }
    await this.#appendEvent(id, {
      protocol: "ensemble-provider-state/v1", kind: "lease", executionId, role: before.active.role,
      expected: lease.expected, ownerId: lease.ownerId, leaseExpiresAt: lease.expiresAt,
      observedAt: lease.observedAt, createdAt: this.#now().toISOString(),
    });
    const state = stateFromEvents(parseEvents(await this.#comments(id)));
    if (!state.active || state.active.id !== executionId || state.active.ownerId !== lease.ownerId
      || state.active.leaseExpiresAt !== lease.expiresAt) {
      if (state.active) throw new ProviderClaimConflict(id, state.active);
      throw new Error(`Vikunja lease renewal ${executionId} was not durable`);
    }
    return state.active;
  }

  async completeExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, completion: ExecutionCompletion): Promise<void> {
    await this.#finish(id, executionId, lease, "complete", completion);
  }

  async failExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, record: ExecutionRecord, status: string, comment: string): Promise<void> {
    await this.#finish(id, executionId, lease, "fail", { record, comments: [comment], artifacts: [], status });
  }

  async cancelExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, cancellation: ExecutionCancellation): Promise<void> {
    await this.#finish(id, executionId, lease, "cancel", {
      record: cancellation.record, comments: [cancellation.comment], artifacts: [], status: cancellation.status,
    });
  }

  async blockExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, cancellation: ExecutionCancellation): Promise<void> {
    await this.#finish(id, executionId, lease, "block", {
      record: cancellation.record, comments: [cancellation.comment], artifacts: [], status: cancellation.status,
    });
  }

  async #finish(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, kind: "complete" | "fail" | "cancel" | "block", completion: ExecutionCompletion): Promise<void> {
    const before = parseEvents(await this.#comments(id));
    const existing = before.find(({ event }) => event.executionId === executionId && isTerminal(event.kind));
    if (!existing) {
      const state = stateFromEvents(before);
      if (!state.active || state.active.id !== executionId) throw new Error(`Execution is not active: ${executionId}`);
      assertLeaseGuard(id, state.active, lease);
      await this.#appendEvent(id, {
        protocol: "ensemble-provider-state/v1", kind, executionId, role: completion.record.role,
        createdAt: completion.record.finishedAt, record: completion.record, artifacts: completion.artifacts,
        ownerId: lease.ownerId, leaseExpiresAt: lease.leaseExpiresAt, observedAt: lease.observedAt,
      });
      const durable = stateFromEvents(parseEvents(await this.#comments(id)));
      const recorded = durable.history.find((record) => record.id === executionId);
      if (!recorded || !sameRecord(recorded, completion.record)) {
        if (durable.active) throw new ProviderClaimConflict(id, durable.active);
        throw new Error(`Vikunja terminal event ${executionId} was not durable`);
      }
    } else if (!existing.event.record || !sameRecord(validateRecord(existing.event.record), completion.record)) {
      throw new Error(`Conflicting execution record: ${executionId}`);
    }
    const comments = await this.#comments(id);
    for (const [index, body] of completion.comments.entries()) {
      const marker = `${SIDE_EFFECT_PREFIX}${executionId}:${index} -->`;
      if (!comments.some((comment) => comment.comment?.includes(marker))) await this.#createRawComment(id, `${marker}\n${body}`);
    }
    await this.updateStatus(id, completion.status);
  }

  async #comments(id: TaskId): Promise<readonly VikunjaComment[]> {
    const comments = await this.client.request<unknown>("GET", `tasks/${taskNumber(id)}/comments?order_by=asc`);
    if (!Array.isArray(comments)) throw new Error(`Vikunja comments for task ${id} are not an array`);
    return comments.map(validateComment);
  }

  async #createRawComment(id: TaskId, body: string): Promise<VikunjaComment> {
    return validateComment(await this.client.request<unknown>("PUT", `tasks/${taskNumber(id)}/comments`, { comment: body }));
  }

  async #appendEvent(id: TaskId, event: ProviderEvent): Promise<void> {
    await this.#createRawComment(id, `${STATE_PREFIX}${JSON.stringify(event)}${STATE_SUFFIX}`);
  }

  async #statusLabelIds(): Promise<ReadonlyMap<string, number>> {
    if (this.#labelIds) return this.#labelIds;
    const labels = await this.client.paginate<VikunjaLabel>("labels");
    const byTitle = new Map(labels.map((label) => [requiredString(label.title, "label title"), requiredNumber(label.id, "label id")]));
    const resolved = new Map<string, number>();
    for (const [status, title] of Object.entries(this.statusLabels)) {
      const id = byTitle.get(title);
      if (id === undefined) throw new Error(`Required Vikunja label is missing: ${title}`);
      resolved.set(status, id);
    }
    this.#labelIds = resolved;
    return resolved;
  }

  #normalizeTask(raw: VikunjaTask): Task {
    const id = String(requiredNumber(raw.id, "task id"));
    if (raw.project_id !== undefined && raw.project_id !== this.projectId) throw new Error(`Task ${id} belongs to unexpected project ${raw.project_id}`);
    const labels = (raw.labels ?? []).map((label) => requiredString(label.title, "label title"));
    const assignees = (raw.assignees ?? []).map((user) => requiredString(user.username, "assignee username"));
    const blockers = normalizeBlockers(raw.related_tasks?.blocked ?? []);
    const status = portableStatus(Boolean(raw.done), labels, this.statusLabels);
    const hasAssignee = this.requiredAssignee === undefined || assignees.includes(this.requiredAssignee);
    const hasLabels = this.requiredLabels.every((label) => labels.includes(label));
    const dispatchable = !raw.done && hasAssignee && hasLabels && blockers.every((blocker) => blocker.resolved);
    return Object.freeze({
      id,
      title: requiredString(raw.title, "task title"),
      description: raw.description ?? "",
      acceptanceCriteria: Object.freeze([]),
      status,
      labels: Object.freeze(labels),
      assignees: Object.freeze(assignees),
      dispatchable,
      priority: raw.priority === undefined ? undefined : -raw.priority,
      blockers: Object.freeze(blockers),
      repository: this.repository,
      metadata: Object.freeze({ provider: "vikunja", identifier: raw.identifier ?? id, projectId: this.projectId }),
    });
  }
}

function stateFromEvents(events: readonly ParsedEvent[]): ProviderExecutionState {
  const terminalByExecution = new Map<string, ExecutionRecord>();
  let active: ActiveExecution | undefined;
  for (const parsed of events) {
    const { event } = parsed;
    if (event.kind === "artifact") continue;
    if (event.kind === "claim") {
      if (event.expected) {
        if (!basisMatches(event.expected, active)) continue;
        const observed = Date.parse(requiredCanonicalTimestamp(event.observedAt, "claim observedAt"));
        if (active?.ownerId && active.leaseExpiresAt && active.ownerId !== event.ownerId
          && Date.parse(active.leaseExpiresAt) > observed) continue;
        active = Object.freeze({
          id: active?.id ?? event.executionId,
          role: active?.role ?? requiredString(event.role, "claim role"),
          startedAt: active?.startedAt ?? parsed.createdAt,
          ownerId: requiredString(event.ownerId, "claim owner"),
          leaseExpiresAt: requiredCanonicalTimestamp(event.leaseExpiresAt, "claim expiry"),
        });
        continue;
      }
      const history = [...terminalByExecution.values()].sort(compareRecords);
      const basis = history.at(-1)?.id ?? "root";
      if (!active && event.basis === basis && !terminalByExecution.has(event.executionId)) {
        active = Object.freeze({ id: event.executionId, role: requiredString(event.role, "claim role"), startedAt: parsed.createdAt });
      }
      continue;
    }
    if (event.kind === "lease") {
      if (!event.expected || !basisMatches(event.expected, active) || !active?.ownerId || !active.leaseExpiresAt
        || active.id !== event.executionId || active.ownerId !== event.ownerId
        || Date.parse(active.leaseExpiresAt) <= Date.parse(requiredCanonicalTimestamp(event.observedAt, "lease observedAt"))) continue;
      const expiry = requiredCanonicalTimestamp(event.leaseExpiresAt, "lease expiry");
      if (Date.parse(expiry) <= Date.parse(active.leaseExpiresAt)) continue;
      active = Object.freeze({ ...active, leaseExpiresAt: expiry });
      continue;
    }
    if (!event.record) continue;
    const record = validateRecord(event.record);
    if (!active || active.id !== event.executionId) {
      if (!event.ownerId && !terminalByExecution.has(event.executionId)) terminalByExecution.set(event.executionId, record);
      continue;
    }
    if (active.ownerId) {
      if (!event.ownerId || !event.leaseExpiresAt || !event.observedAt
        || active.ownerId !== event.ownerId || active.leaseExpiresAt !== event.leaseExpiresAt
        || Date.parse(event.leaseExpiresAt) <= Date.parse(event.observedAt)) continue;
    }
    if (!terminalByExecution.has(event.executionId)) terminalByExecution.set(event.executionId, record);
    active = undefined;
  }
  const history = [...terminalByExecution.values()].sort(compareRecords);
  return Object.freeze({
    active,
    history: Object.freeze(history.map(freezeExecutionRecord)),
    nextRole: history.at(-1)?.nextRole,
  });
}

function parseEvents(comments: readonly VikunjaComment[]): readonly ParsedEvent[] {
  return comments.flatMap((comment): ParsedEvent[] => {
    const body = requiredString(comment.comment, "comment");
    if (!body.startsWith(STATE_PREFIX)) return [];
    if (!body.endsWith(STATE_SUFFIX)) throw new Error(`Malformed Ensemble provider state comment ${String(comment.id)}`);
    let value: unknown;
    try { value = JSON.parse(body.slice(STATE_PREFIX.length, -STATE_SUFFIX.length)); }
    catch { throw new Error(`Malformed Ensemble provider state comment ${String(comment.id)}`); }
    const event = validateEvent(value);
    return [{ event, commentId: requiredNumber(comment.id, "comment id"), createdAt: requiredDate(comment.created, "comment created") }];
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.commentId - right.commentId);
}

function validateEvent(value: unknown): ProviderEvent {
  if (!value || typeof value !== "object") throw new Error("Invalid Ensemble provider event");
  const event = value as Partial<ProviderEvent>;
  if (event.protocol !== "ensemble-provider-state/v1" || !event.kind || !["claim", "lease", "complete", "fail", "cancel", "block", "artifact"].includes(event.kind)
    || typeof event.executionId !== "string" || !event.executionId || typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt))) {
    throw new Error("Invalid Ensemble provider event");
  }
  if (event.kind === "claim" && (typeof event.role !== "string" || !event.role
    || (event.expected === undefined && typeof event.basis !== "string"))) throw new Error("Invalid Ensemble claim event");
  if ((event.kind === "claim" || event.kind === "lease") && event.expected !== undefined) {
    validateLeaseBasis(event.expected);
    requiredString(event.ownerId, `${event.kind} owner`);
    requiredCanonicalTimestamp(event.leaseExpiresAt, `${event.kind} expiry`);
    requiredCanonicalTimestamp(event.observedAt, `${event.kind} observedAt`);
  }
  if (event.kind === "lease" && event.expected === undefined) throw new Error("Invalid Ensemble lease event");
  if (isTerminal(event.kind) && !event.record) throw new Error("Invalid Ensemble terminal event");
  if (isTerminal(event.kind) && event.record?.id !== event.executionId) throw new Error("Ensemble terminal event execution ID mismatch");
  if (event.artifacts !== undefined && (!Array.isArray(event.artifacts) || event.artifacts.some((artifact) => !artifact || typeof artifact.type !== "string" || typeof artifact.url !== "string"))) {
    throw new Error("Invalid Ensemble event artifacts");
  }
  return event as ProviderEvent;
}

function validateRecord(record: ExecutionRecord): ExecutionRecord {
  if (!record || typeof record !== "object" || typeof record.id !== "string" || typeof record.role !== "string"
    || typeof record.outcome !== "string" || typeof record.summary !== "string" || typeof record.finishedAt !== "string"
    || Number.isNaN(Date.parse(record.finishedAt)) || (record.nextRole !== undefined && typeof record.nextRole !== "string")
    || (record.failure !== undefined && !isValidFailure(record.failure))) {
    throw new Error("Invalid Vikunja execution record");
  }
  return record;
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

function validateComment(value: unknown): VikunjaComment {
  if (!value || typeof value !== "object") throw new Error("Invalid Vikunja comment");
  const comment = value as VikunjaComment;
  requiredNumber(comment.id, "comment id");
  requiredString(comment.comment, "comment");
  requiredDate(comment.created, "comment created");
  return comment;
}

function validateView(value: unknown): Required<Pick<VikunjaView, "id" | "title" | "view_kind">> {
  if (!value || typeof value !== "object") throw new Error("Invalid Vikunja project view");
  const view = value as VikunjaView;
  return {
    id: requiredNumber(view.id, "view id"),
    title: requiredString(view.title, "view title"),
    view_kind: requiredString(view.view_kind, "view kind"),
  };
}

function normalizeBlockers(tasks: readonly VikunjaTask[]): readonly TaskBlocker[] {
  return tasks.map((task) => ({ id: String(requiredNumber(task.id, "blocker id")), status: task.done ? "completed" : "open", resolved: Boolean(task.done) }));
}

function portableStatus(done: boolean, labels: readonly string[], configured: VikunjaStatusLabels): string {
  if (done || labels.includes(configured.completed)) return "completed";
  if (labels.includes(configured.blocked)) return "blocked";
  if (labels.includes(configured.failed)) return "failed";
  if (labels.includes(configured.running)) return "running";
  if (labels.includes(configured.ready)) return "ready";
  return "unmanaged";
}

function assertDistinctStatuses(labels: VikunjaStatusLabels): void {
  if (new Set(Object.values(labels)).size !== Object.keys(labels).length) throw new Error("Vikunja status labels must be distinct");
}

function taskNumber(id: TaskId): number {
  if (!/^\d+$/u.test(id)) throw new Error(`Invalid Vikunja task ID: ${id}`);
  return positiveInteger(Number(id), "task id");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid Vikunja ${name}`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid Vikunja ${name}`);
  return value;
}

function requiredDate(value: unknown, name: string): string {
  const date = requiredString(value, name);
  if (Number.isNaN(Date.parse(date))) throw new Error(`Invalid Vikunja ${name}`);
  return date;
}

function requiredCanonicalTimestamp(value: unknown, name: string): string {
  if (!isCanonicalTimestamp(value)) throw new Error(`Invalid Vikunja ${name}`);
  return value;
}

function validateLeaseClaim(lease: ExecutionLeaseClaim): void {
  if (!lease.ownerId.trim() || !isCanonicalTimestamp(lease.observedAt) || !isCanonicalTimestamp(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= Date.parse(lease.observedAt)) throw new Error("Invalid execution lease claim");
  validateLeaseBasis(lease.expected);
}

function validateLeaseBasis(basis: ExecutionLeaseBasis): void {
  if (basis.kind === "none") return;
  if (!basis.executionId || !basis.role || !isCanonicalTimestamp(basis.startedAt)) throw new Error("Invalid execution lease basis");
  if (basis.kind === "leased" && (!basis.ownerId || !isCanonicalTimestamp(basis.leaseExpiresAt))) throw new Error("Invalid execution lease basis");
}

function basisMatches(basis: ExecutionLeaseBasis, active: ActiveExecution | undefined): boolean {
  if (basis.kind === "none") return active === undefined;
  if (!active || basis.executionId !== active.id || basis.role !== active.role || basis.startedAt !== active.startedAt) return false;
  return basis.kind === "legacy"
    ? active.ownerId === undefined && active.leaseExpiresAt === undefined
    : basis.ownerId === active.ownerId && basis.leaseExpiresAt === active.leaseExpiresAt;
}

function assertLeaseBasis(taskId: TaskId, basis: ExecutionLeaseBasis, active: ActiveExecution | undefined): void {
  validateLeaseBasis(basis);
  if (basisMatches(basis, active)) return;
  if (active) throw new ProviderClaimConflict(taskId, active);
  throw new Error(`Execution lease basis no longer exists for task ${taskId}`);
}

function assertLeaseGuard(taskId: TaskId, active: ActiveExecution, guard: ExecutionLeaseGuard): void {
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

function compareRecords(left: ExecutionRecord, right: ExecutionRecord): number {
  return left.finishedAt.localeCompare(right.finishedAt) || left.id.localeCompare(right.id);
}

function freezeExecutionRecord(record: ExecutionRecord): ExecutionRecord {
  return Object.freeze({
    ...record,
    failure: record.failure && Object.freeze({ ...record.failure }),
    blockingRequest: record.blockingRequest && Object.freeze({ ...record.blockingRequest }),
  });
}

function isTerminal(kind: ProviderEvent["kind"]): kind is "complete" | "fail" | "cancel" | "block" {
  return kind === "complete" || kind === "fail" || kind === "cancel" || kind === "block";
}

function stripSideEffectMarker(body: string): string {
  return body.startsWith(SIDE_EFFECT_PREFIX) ? body.slice(body.indexOf("\n") + 1) : body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
