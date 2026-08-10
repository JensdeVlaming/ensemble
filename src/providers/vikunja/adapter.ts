import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Artifact, FailureKind, PortableJsonValue, RepositoryRef, RuntimeTool, Task, TaskBlocker, TaskComment, TaskId,
} from "../../domain/model.ts";
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
  ProviderJournalDiagnostic,
  ProviderTaskDiagnostic,
  ProviderTaskInventory,
  TaskQuery,
  TaskRefreshResult,
} from "../provider.ts";
import { ProviderClaimConflict } from "../provider.ts";
import { VikunjaApiError, VikunjaClient, VikunjaPaginationLimitError } from "./client.ts";
import type { VikunjaClientOptions } from "./client.ts";

const STATE_PREFIX = "<!-- ensemble-provider-state:v1\n";
const STATE_SUFFIX = "\n-->";
const SIDE_EFFECT_PREFIX = "<!-- ensemble-side-effect:";
const AGENT_TOOL_PREFIX = "<!-- ensemble-agent-tool:v1:";
const TOOL_ITEM_LIMIT = 100;
const TOOL_TEXT_LIMIT = 8_192;
const TOOL_RESULT_BUDGET = 196_608;
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
  readonly inventoryMaxProjects?: number;
  readonly inventoryMaxTasks?: number;
  readonly inventoryConcurrency?: number;
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
  readonly comments?: readonly string[];
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
  readonly #inventoryMaxProjects: number;
  readonly #inventoryMaxTasks: number;
  readonly #inventoryConcurrency: number;
  #labelIds?: ReadonlyMap<string, number>;
  readonly #toolMutations = new Map<string, Promise<void>>();

  constructor(options: VikunjaProviderOptions) {
    this.client = new VikunjaClient({ ...options, repositoryId: options.repository.id });
    this.projectId = positiveInteger(options.projectId, "projectId");
    this.viewId = positiveInteger(options.viewId, "viewId");
    this.repository = Object.freeze({ ...options.repository });
    this.requiredAssignee = options.requiredAssignee;
    this.requiredLabels = Object.freeze([...(options.requiredLabels ?? [])]);
    this.statusLabels = Object.freeze({ ...DEFAULT_STATUS_LABELS, ...options.statusLabels });
    assertDistinctStatuses(this.statusLabels);
    this.#executionId = options.executionId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#inventoryMaxProjects = positiveInteger(options.inventoryMaxProjects ?? 100, "inventoryMaxProjects");
    this.#inventoryMaxTasks = positiveInteger(options.inventoryMaxTasks ?? 2_000, "inventoryMaxTasks");
    this.#inventoryConcurrency = positiveInteger(options.inventoryConcurrency ?? 4, "inventoryConcurrency");
  }

  async validateConfiguration(): Promise<void> {
    const project = await this.client.request<VikunjaProject>("GET", `projects/${this.projectId}`);
    if (requiredNumber(project.id, "project id") !== this.projectId) throw new Error("Vikunja returned a different project");
    requiredString(project.title, "project title");
    if (typeof project.is_archived !== "boolean") throw new Error("Invalid Vikunja project archive state");
    const views = await this.client.request<unknown>("GET", `projects/${this.projectId}/views`);
    if (!Array.isArray(views)) throw new Error("Vikunja project views response is not an array");
    const selected = views.map(validateView).find((view) => view.id === this.viewId);
    if (!selected) throw new Error(`Vikunja project view does not exist: ${this.viewId}`);
    if (selected.view_kind === "kanban") throw new Error("Vikunja discovery view must return a task list, not Kanban buckets");
    await this.#statusLabelIds();
  }

  async discoverTasks(query: TaskQuery): Promise<readonly Task[]> {
    if (query.scope !== "workflow_candidates") throw new Error(`Unsupported task query scope: ${String(query.scope)}`);
    const projectPageLimit = Math.ceil(this.#inventoryMaxProjects / this.client.perPage);
    const projects = [...await this.client.paginate<VikunjaProject>("projects", { is_archived: true }, {
      maxPages: projectPageLimit, maxItems: this.#inventoryMaxProjects,
    })].map(validateProject).sort((left, right) => left.id - right.id);
    const configuredProject = projects.find((project) => project.id === this.projectId);
    if (!configuredProject) throw new Error(`Vikunja configured project is not visible: ${this.projectId}`);
    const activeProjects = projects.filter((project) => !project.is_archived);

    const inventory: VikunjaTask[] = [];
    for (const project of activeProjects) {
      const remaining = this.#inventoryMaxTasks - inventory.length;
      if (remaining <= 0) throw new VikunjaPaginationLimitError("project task inventory", "items");
      const tasks = await this.client.paginate<VikunjaTask>(`projects/${project.id}/tasks`, { expand: "buckets" }, {
        maxPages: Math.ceil(remaining / this.client.perPage), maxItems: remaining,
      });
      inventory.push(...tasks);
    }

    const ordinary = configuredProject.is_archived ? [] : await this.client.paginate<VikunjaTask>(
      `projects/${this.projectId}/views/${this.viewId}/tasks`,
      { sort_by: "priority", order_by: "desc", expand: "buckets" },
      { maxPages: Math.ceil(this.#inventoryMaxTasks / this.client.perPage), maxItems: this.#inventoryMaxTasks },
    );
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const candidates = new Map<string, Task>();
    for (const raw of ordinary) {
      const normalized = this.#normalizeTask(raw, Boolean(projectById.get(requiredNumber(raw.project_id, "task project id"))?.is_archived));
      if (normalized.dispatchable && (normalized.status === "ready" || normalized.status === "failed")) candidates.set(normalized.id, normalized);
    }
    const active = await mapBounded(
      inventory.filter((task) => !task.done).sort((left, right) => requiredNumber(left.id, "task id") - requiredNumber(right.id, "task id")),
      this.#inventoryConcurrency,
      async (raw) => ({ raw, state: await this.getExecutionState(String(requiredNumber(raw.id, "task id"))) }),
    );
    for (const { raw, state } of active) {
      if (!state.active) continue;
      const project = projectById.get(requiredNumber(raw.project_id, "task project id"));
      const normalized = this.#normalizeTask(raw, project?.is_archived ?? true, true);
      candidates.set(normalized.id, normalized);
    }
    return Object.freeze([...candidates.values()].sort(compareTasks));
  }

  async inventoryTasks(): Promise<ProviderTaskInventory> {
    const projects = [...await this.client.paginate<VikunjaProject>("projects", { is_archived: true }, {
      maxPages: Math.ceil(this.#inventoryMaxProjects / this.client.perPage), maxItems: this.#inventoryMaxProjects,
    })].map(validateProject).sort((left, right) => left.id - right.id);
    if (!projects.some((project) => project.id === this.projectId)) {
      throw new Error(`Vikunja configured project is not visible: ${this.projectId}`);
    }
    const entries: Array<ProviderTaskInventory["entries"][number]> = [];
    for (const project of projects) {
      const remaining = this.#inventoryMaxTasks - entries.length;
      if (remaining <= 0) throw new VikunjaPaginationLimitError("workspace task inventory", "items");
      const tasks = await this.client.paginate<VikunjaTask>(`projects/${project.id}/tasks`, { expand: "buckets" }, {
        maxPages: Math.ceil(remaining / this.client.perPage), maxItems: remaining,
      });
      for (const raw of tasks) {
        const task = this.#normalizeTask(raw, project.is_archived);
        entries.push(Object.freeze({ task, lifecycle: project.is_archived || task.status === "completed" ? "terminal" : "current" }));
      }
    }
    entries.sort((left, right) => left.task.id.localeCompare(right.task.id));
    return Object.freeze({ completeness: "complete", entries: Object.freeze(entries) });
  }

  async refreshTasks(ids: readonly TaskId[]): Promise<ReadonlyMap<TaskId, TaskRefreshResult>> {
    const results = new Map<TaskId, TaskRefreshResult>();
    await mapBounded([...ids].sort(), this.#inventoryConcurrency, async (id) => {
      try {
        const raw = await this.client.request<VikunjaTask>("GET", `tasks/${taskNumber(id)}?expand=buckets`);
        const projectId = requiredNumber(raw.project_id, "task project id");
        const project = validateProject(await this.client.request<VikunjaProject>("GET", `projects/${projectId}`));
        results.set(id, project.is_archived ? { kind: "missing" } : { kind: "current", task: this.#normalizeTask(raw, false) });
      } catch (error) {
        if (error instanceof VikunjaApiError && error.status === 404) results.set(id, { kind: "missing" });
        else results.set(id, { kind: "unreadable", error: errorMessage(error) });
      }
    });
    return new Map([...results].sort(([left], [right]) => left.localeCompare(right)));
  }

  async getTask(id: TaskId): Promise<Task> {
    const raw = await this.client.request<VikunjaTask>("GET", `tasks/${taskNumber(id)}?expand=buckets`);
    const project = validateProject(await this.client.request<VikunjaProject>("GET", `projects/${requiredNumber(raw.project_id, "task project id")}`));
    return this.#normalizeTask(raw, project.is_archived);
  }

  async getComments(id: TaskId): Promise<readonly TaskComment[]> {
    const comments = await this.#comments(id);
    const ordinary = comments.flatMap((comment): TaskComment[] => {
      const body = requiredString(comment.comment, "comment");
      if (body.startsWith(STATE_PREFIX)) return [];
      return [{
        id: String(requiredNumber(comment.id, "comment id")),
        body: stripAgentToolMarker(stripSideEffectMarker(body)),
        author: comment.author?.username,
        createdAt: requiredDate(comment.created, "comment created"),
      }];
    });
    const folded = foldEvents(parseEvents(comments));
    const terminal = [...folded.terminals.values()].flatMap((event): TaskComment[] =>
      (event.comments ?? []).map((body, index) => Object.freeze({
        id: `${event.executionId}:comment:${index}`, body,
        createdAt: requiredDate(event.record?.finishedAt, "terminal comment created"),
      })));
    return Object.freeze([...ordinary, ...terminal].sort(compareComments));
  }

  async getArtifacts(id: TaskId): Promise<readonly Artifact[]> {
    const events = parseEvents(await this.#comments(id));
    const folded = foldEvents(events);
    const artifacts = [
      ...events.filter(({ event }) => event.kind === "artifact").flatMap(({ event }) => event.artifacts ?? []),
      ...[...folded.terminals.values()].flatMap((event) => event.artifacts ?? []),
    ];
    return Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact })));
  }

  async getRuntimeTools(id: TaskId, executionId: string, ownerId: string): Promise<readonly RuntimeTool[]> {
    await this.#assertActiveToolExecution(id, executionId, ownerId);
    const emptyInput = Object.freeze({ type: "object", properties: Object.freeze({}),
      required: Object.freeze([]), additionalProperties: false } as const);
    const tools: RuntimeTool[] = [
      {
        name: "task_read",
        description: "Read the claimed Vikunja task and its portable workflow fields.",
        inputSchema: emptyInput,
        invoke: async () => this.#invokeTool("task_read", async () => {
          await this.#assertActiveToolExecution(id, executionId, ownerId);
          return boundedTask(await this.getTask(id));
        }),
      },
      {
        name: "task_comments_read",
        description: "Read bounded, ordinary comments for the claimed Vikunja task.",
        inputSchema: emptyInput,
        invoke: async () => this.#invokeTool("task_comments_read", async () => {
          await this.#assertActiveToolExecution(id, executionId, ownerId);
          return boundedCollection((await this.getComments(id)).slice(-TOOL_ITEM_LIMIT), boundedComment);
        }),
      },
      {
        name: "task_artifacts_read",
        description: "Read bounded artifact references for the claimed Vikunja task.",
        inputSchema: emptyInput,
        invoke: async () => this.#invokeTool("task_artifacts_read", async () => {
          await this.#assertActiveToolExecution(id, executionId, ownerId);
          return boundedCollection((await this.getArtifacts(id)).slice(-TOOL_ITEM_LIMIT), boundedArtifact);
        }),
      },
      {
        name: "task_comment_add",
        description: "Add one idempotent comment to the claimed Vikunja task.",
        inputSchema: Object.freeze({
          type: "object",
          properties: Object.freeze({
            body: Object.freeze({ type: "string", description: "Comment text." }),
            idempotencyKey: Object.freeze({ type: "string", description: "Stable key reused when retrying this write." }),
          }),
          required: Object.freeze(["body", "idempotencyKey"]),
          additionalProperties: false,
        }),
        invoke: async (input) => this.#invokeTool("task_comment_add", async () => {
          const values = toolCommentInput(input);
          return this.#serializeToolMutation(`${id}:${executionId}:${values.idempotencyKey}`, async () => {
            await this.#assertActiveToolExecution(id, executionId, ownerId);
            const marker = agentToolMarker(executionId, values.idempotencyKey);
            const existing = await this.#reconcileAgentComments(id, marker, values.body);
            if (existing) return boundedComment(existing);
            await this.#createRawComment(id, `${marker}\n${values.body}`);
            return boundedComment((await this.#reconcileAgentComments(id, marker, values.body))!);
          });
        }),
      },
    ];
    return Object.freeze(tools.map((tool) => Object.freeze(tool)));
  }

  async getExecutionState(id: TaskId): Promise<ProviderExecutionState> {
    return stateFromEvents(parseEvents(await this.#comments(id)));
  }

  async inspectTask(id: TaskId, options: { readonly includeJournal?: boolean } = {}): Promise<ProviderTaskDiagnostic> {
    const [task, comments] = await Promise.all([this.getTask(id), this.#comments(id)]);
    const events = parseEvents(comments);
    const execution = stateFromEvents(events);
    const ordinaryCommentCount = comments.filter((comment) => !requiredString(comment.comment, "comment").startsWith(STATE_PREFIX)).length;
    const terminalCommentCount = [...foldEvents(events).terminals.values()]
      .reduce((count, event) => count + (event.comments?.length ?? 0), 0);
    const artifacts = events.reduce((count, parsed) => count + (parsed.event.artifacts?.length ?? 0), 0);
    return Object.freeze({
      task: diagnosticTask(task),
      execution: diagnosticExecution(execution),
      commentCount: ordinaryCommentCount + terminalCommentCount,
      artifactCount: artifacts,
      ...(options.includeJournal ? { journal: diagnosticJournal(events) } : {}),
    });
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
    const foldedBefore = foldEvents(before);
    const existing = foldedBefore.terminals.get(executionId);
    if (!existing) {
      const state = foldedBefore.state;
      if (!state.active || state.active.id !== executionId) throw new Error(`Execution is not active: ${executionId}`);
      assertLeaseGuard(id, state.active, lease);
      await this.#appendEvent(id, {
        protocol: "ensemble-provider-state/v1", kind, executionId, role: completion.record.role,
        createdAt: completion.record.finishedAt, record: completion.record, artifacts: completion.artifacts,
        comments: completion.comments,
        ownerId: lease.ownerId, leaseExpiresAt: lease.leaseExpiresAt, observedAt: lease.observedAt,
      });
      const durable = foldEvents(parseEvents(await this.#comments(id)));
      const recorded = durable.terminals.get(executionId);
      if (!recorded || !sameTerminalPayload(recorded, completion)) {
        if (durable.state.active) throw new ProviderClaimConflict(id, durable.state.active);
        throw new Error(`Vikunja terminal event ${executionId} was not durable`);
      }
    } else if (!existing.record || !sameRecord(validateRecord(existing.record), completion.record)
      || (existing.comments !== undefined && !sameStrings(existing.comments, completion.comments))
      || (existing.artifacts !== undefined && !sameArtifacts(existing.artifacts, completion.artifacts))) {
      throw new Error(`Conflicting execution record: ${executionId}`);
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

  async #assertActiveToolExecution(id: TaskId, executionId: string, ownerId: string): Promise<void> {
    const state = stateFromEvents(parseEvents(await this.#comments(id)));
    if (state.active?.id !== executionId || state.active.ownerId !== ownerId) {
      throw new Error("Vikunja tool execution is no longer active");
    }
  }

  async #reconcileAgentComments(id: TaskId, marker: string, body: string): Promise<TaskComment | undefined> {
    const matches = (await this.#comments(id)).filter((comment) =>
      requiredString(comment.comment, "comment").startsWith(`${marker}\n`))
      .sort((left, right) => requiredNumber(left.id, "comment id") - requiredNumber(right.id, "comment id"));
    const winner = matches[0];
    if (!winner) return undefined;
    const normalized = normalizeOrdinaryComment(winner);
    for (const duplicate of matches.slice(1)) {
      try { await this.client.request("DELETE", `tasks/${taskNumber(id)}/comments/${requiredNumber(duplicate.id, "comment id")}`); }
      catch (error) { if (!(error instanceof VikunjaApiError && error.status === 404)) throw error; }
    }
    if (normalized.body !== body) throw new Error("Conflicting comment tool idempotency key");
    return normalized;
  }

  async #invokeTool<T extends PortableJsonValue>(name: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch { throw new Error(`Vikunja tool ${name} failed`); }
  }

  async #serializeToolMutation<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#toolMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#toolMutations.set(key, queued);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.#toolMutations.get(key) === queued) this.#toolMutations.delete(key);
    }
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

  #normalizeTask(raw: VikunjaTask, projectArchived = false, active = false): Task {
    const id = String(requiredNumber(raw.id, "task id"));
    const projectId = requiredNumber(raw.project_id, "task project id");
    const labels = (raw.labels ?? []).map((label) => requiredString(label.title, "label title"));
    const assignees = (raw.assignees ?? []).map((user) => requiredString(user.username, "assignee username"));
    const blockers = normalizeBlockers(raw.related_tasks?.blocked ?? []);
    const providerStatus = portableStatus(Boolean(raw.done), labels, this.statusLabels);
    const status = active && providerStatus === "unmanaged" ? "running" : providerStatus;
    const hasAssignee = this.requiredAssignee === undefined || assignees.includes(this.requiredAssignee);
    const hasLabels = this.requiredLabels.every((label) => labels.includes(label));
    const dispatchable = !raw.done && !projectArchived && projectId === this.projectId
      && hasAssignee && hasLabels && blockers.every((blocker) => blocker.resolved);
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
      metadata: Object.freeze({ provider: "vikunja", identifier: raw.identifier ?? id, projectId }),
    });
  }
}

interface FoldedEvents {
  readonly state: ProviderExecutionState;
  readonly terminals: ReadonlyMap<string, ProviderEvent>;
}

function stateFromEvents(events: readonly ParsedEvent[]): ProviderExecutionState {
  return foldEvents(events).state;
}

function foldEvents(events: readonly ParsedEvent[]): FoldedEvents {
  const terminalByExecution = new Map<string, ExecutionRecord>();
  const terminalEvents = new Map<string, ProviderEvent>();
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
      if (!event.ownerId && !terminalByExecution.has(event.executionId)) {
        terminalByExecution.set(event.executionId, record);
        terminalEvents.set(event.executionId, event);
      }
      continue;
    }
    if (active.ownerId) {
      if (!event.ownerId || !event.leaseExpiresAt || !event.observedAt
        || active.ownerId !== event.ownerId || active.leaseExpiresAt !== event.leaseExpiresAt
        || Date.parse(event.leaseExpiresAt) <= Date.parse(event.observedAt)) continue;
    }
    if (!terminalByExecution.has(event.executionId)) {
      terminalByExecution.set(event.executionId, record);
      terminalEvents.set(event.executionId, event);
    }
    active = undefined;
  }
  const history = [...terminalByExecution.values()].sort(compareRecords);
  const state = Object.freeze({
    active,
    history: Object.freeze(history.map(freezeExecutionRecord)),
    nextRole: history.at(-1)?.nextRole,
  });
  return Object.freeze({ state, terminals: terminalEvents });
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
    return [{ event, commentId: requiredNumber(comment.id, "comment id"),
      createdAt: canonicalProviderTimestamp(comment.created, "comment created") }];
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.commentId - right.commentId);
}

function diagnosticJournal(events: readonly ParsedEvent[]): readonly ProviderJournalDiagnostic[] {
  const selected = events.slice(-1_000);
  const offset = events.length - selected.length;
  return Object.freeze(selected.map((parsed, sequence) => Object.freeze({
    sequence: offset + sequence + 1,
    kind: parsed.event.kind,
    executionId: boundedText(parsed.event.executionId, 256),
    createdAt: parsed.createdAt,
    ...(parsed.event.role ? { role: boundedText(parsed.event.role, 256) } : {}),
    ...(parsed.event.ownerId ? { ownerId: boundedText(parsed.event.ownerId, 256) } : {}),
    ...(parsed.event.leaseExpiresAt ? { leaseExpiresAt: parsed.event.leaseExpiresAt } : {}),
    ...(parsed.event.record?.outcome ? { outcome: parsed.event.record.outcome } : {}),
  })));
}

function diagnosticTask(task: Task): ProviderTaskDiagnostic["task"] {
  return Object.freeze({
    id: boundedText(task.id, 256),
    title: boundedText(task.title, 1_024),
    status: boundedText(task.status, 256),
    ...(task.dispatchable === undefined ? {} : { dispatchable: task.dispatchable }),
    labels: Object.freeze(task.labels.slice(0, 100).map((value) => boundedText(value, 256))),
    assignees: Object.freeze(task.assignees.slice(0, 100).map((value) => boundedText(value, 256))),
    ...(task.blockers ? { blockers: Object.freeze(task.blockers.slice(0, 100).map((blocker) => Object.freeze({
      id: boundedText(blocker.id, 256), resolved: blocker.resolved,
      ...(blocker.status === undefined ? {} : { status: boundedText(blocker.status, 256) }),
    }))) } : {}),
  });
}

function diagnosticExecution(state: ProviderExecutionState): ProviderTaskDiagnostic["execution"] {
  const active = state.active ? Object.freeze({
    id: boundedText(state.active.id, 256),
    role: boundedText(state.active.role, 256),
    startedAt: state.active.startedAt,
    ...(state.active.ownerId ? { ownerId: boundedText(state.active.ownerId, 256) } : {}),
    ...(state.active.leaseExpiresAt ? { leaseExpiresAt: state.active.leaseExpiresAt } : {}),
  }) : undefined;
  const history = state.history.slice(-100).map((record) => Object.freeze({
    id: boundedText(record.id, 256),
    role: boundedText(record.role, 256),
    outcome: boundedText(record.outcome, 256),
    finishedAt: new Date(Date.parse(record.finishedAt)).toISOString(),
    ...(record.nextRole ? { nextRole: boundedText(record.nextRole, 256) } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
  }));
  return Object.freeze({
    ...(active ? { active } : {}),
    history: Object.freeze(history),
    ...(state.nextRole ? { nextRole: boundedText(state.nextRole, 256) } : {}),
  });
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
  if (event.comments !== undefined && (!Array.isArray(event.comments)
    || event.comments.some((comment) => typeof comment !== "string"))) throw new Error("Invalid Ensemble event comments");
  return event as ProviderEvent;
}

function validateRecord(record: ExecutionRecord): ExecutionRecord {
  const blockingRequest = record?.blockingRequest === undefined ? undefined : normalizeBlockingRequest(record.blockingRequest);
  if (!record || typeof record !== "object" || typeof record.id !== "string" || typeof record.role !== "string"
    || typeof record.outcome !== "string" || typeof record.summary !== "string" || typeof record.finishedAt !== "string"
    || Number.isNaN(Date.parse(record.finishedAt)) || (record.nextRole !== undefined && typeof record.nextRole !== "string")
    || (record.failure !== undefined && !isValidFailure(record.failure))
    || (record.outcome === "blocked") !== (blockingRequest !== undefined)) {
    throw new Error("Invalid Vikunja execution record");
  }
  return { ...record, ...(blockingRequest === undefined ? {} : { blockingRequest }) };
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

function validateProject(value: VikunjaProject): Required<Pick<VikunjaProject, "id" | "title" | "is_archived">> {
  if (!value || typeof value !== "object" || typeof value.is_archived !== "boolean") throw new Error("Invalid Vikunja project");
  return {
    id: positiveInteger(requiredNumber(value.id, "project id"), "project id"),
    title: requiredString(value.title, "project title"),
    is_archived: value.is_archived,
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

function canonicalProviderTimestamp(value: unknown, name: string): string {
  const date = requiredString(value, name);
  const epoch = Date.parse(date);
  if (!Number.isFinite(epoch)) throw new Error(`Invalid Vikunja ${name}`);
  return new Date(epoch).toISOString();
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

function sameTerminalPayload(event: ProviderEvent, completion: ExecutionCompletion): boolean {
  return event.record !== undefined && sameRecord(validateRecord(event.record), completion.record)
    && sameStrings(event.comments ?? [], completion.comments)
    && sameArtifacts(event.artifacts ?? [], completion.artifacts);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameArtifacts(left: readonly Artifact[], right: readonly Artifact[]): boolean {
  return isDeepStrictEqual(left, right);
}

function compareTasks(left: Task, right: Task): number {
  if (left.priority !== undefined || right.priority !== undefined) {
    if (left.priority === undefined) return 1;
    if (right.priority === undefined) return -1;
    if (left.priority !== right.priority) return left.priority - right.priority;
  }
  return left.id.localeCompare(right.id);
}

function compareComments(left: TaskComment, right: TaskComment): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

async function mapBounded<T, TResult>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<TResult>,
): Promise<readonly TResult[]> {
  const results = new Array<TResult>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await work(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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

function stripAgentToolMarker(body: string): string {
  return body.startsWith(AGENT_TOOL_PREFIX) ? body.slice(body.indexOf("\n") + 1) : body;
}

function boundedTask(task: Task): PortableJsonValue {
  const result: Record<string, PortableJsonValue> = {
    id: boundedText(task.id, 256),
    title: boundedText(task.title, TOOL_TEXT_LIMIT),
    description: boundedText(task.description, TOOL_TEXT_LIMIT),
    status: boundedText(task.status, 256),
  };
  addBoundedProperty(result, "acceptanceCriteria", task.acceptanceCriteria,
    (criterion) => boundedText(criterion, TOOL_TEXT_LIMIT));
  addBoundedProperty(result, "labels", task.labels, (label) => boundedText(label, 256));
  addBoundedProperty(result, "assignees", task.assignees, (assignee) => boundedText(assignee, 256));
  addBoundedProperty(result, "blockers", task.blockers ?? [], (blocker) => Object.freeze({
      id: boundedText(blocker.id, 256), resolved: blocker.resolved,
      ...(blocker.status === undefined ? {} : { status: boundedText(blocker.status, 256) }),
    }));
  return Object.freeze(result);
}

function boundedComment(comment: TaskComment): PortableJsonValue {
  return Object.freeze({
    id: boundedText(comment.id, 256),
    body: boundedText(comment.body, TOOL_TEXT_LIMIT),
    createdAt: boundedText(comment.createdAt, 256),
    ...(comment.author === undefined ? {} : { author: boundedText(comment.author, 256) }),
  });
}

function boundedArtifact(artifact: Artifact): PortableJsonValue {
  return Object.freeze({
    type: boundedText(artifact.type, 256),
    url: boundedText(artifact.url, 4_096),
    ...(artifact.name === undefined ? {} : { name: boundedText(artifact.name, 1_024) }),
  });
}

function boundedCollection<T>(values: readonly T[], map: (value: T) => PortableJsonValue): readonly PortableJsonValue[] {
  const result: PortableJsonValue[] = [];
  for (const value of values.slice(0, TOOL_ITEM_LIMIT)) {
    const candidate = map(value);
    if (portableBytes([...result, candidate]) > TOOL_RESULT_BUDGET) break;
    result.push(candidate);
  }
  return Object.freeze(result);
}

function addBoundedProperty<T>(
  result: Record<string, PortableJsonValue>,
  name: string,
  values: readonly T[],
  map: (value: T) => PortableJsonValue,
): void {
  const selected: PortableJsonValue[] = [];
  result[name] = selected;
  for (const value of values.slice(0, TOOL_ITEM_LIMIT)) {
    const candidate = map(value);
    result[name] = [...selected, candidate];
    if (portableBytes(result) > TOOL_RESULT_BUDGET) {
      result[name] = selected;
      break;
    }
    selected.push(candidate);
  }
  result[name] = Object.freeze([...selected]);
}

function portableBytes(value: PortableJsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function toolCommentInput(input: unknown): { readonly body: string; readonly idempotencyKey: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid comment tool input");
  const values = input as Readonly<Record<string, unknown>>;
  if (typeof values.body !== "string" || !values.body.trim() || Buffer.byteLength(values.body, "utf8") > TOOL_TEXT_LIMIT
    || typeof values.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(values.idempotencyKey)) {
    throw new Error("Invalid comment tool input");
  }
  return Object.freeze({ body: values.body, idempotencyKey: values.idempotencyKey });
}

function agentToolMarker(executionId: string, idempotencyKey: string): string {
  return `${AGENT_TOOL_PREFIX}${Buffer.from(executionId, "utf8").toString("base64url")}:${Buffer.from(idempotencyKey, "utf8").toString("base64url")} -->`;
}

function normalizeOrdinaryComment(comment: VikunjaComment): TaskComment {
  const body = stripAgentToolMarker(stripSideEffectMarker(requiredString(comment.comment, "comment")));
  return Object.freeze({
    id: String(requiredNumber(comment.id, "comment id")), body,
    ...(comment.author?.username === undefined ? {} : { author: comment.author.username }),
    createdAt: requiredDate(comment.created, "comment created"),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
