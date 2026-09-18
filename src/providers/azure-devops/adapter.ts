import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Artifact, FailureKind, PortableJsonValue, RepositoryRef, RuntimeTool, Task, TaskBlocker, TaskComment, TaskId } from "../../domain/model.ts";
import type {
  ActiveExecution, ExecutionCancellation, ExecutionCompletion, ExecutionLeaseBasis, ExecutionLeaseClaim,
  ExecutionLeaseGuard, ExecutionRecord, ProviderAdapter, ProviderExecutionState, ProviderJournalDiagnostic,
  ProviderTaskDiagnostic, ProviderTaskInventory, TaskQuery, TaskRefreshResult,
} from "../provider.ts";
import { ProviderClaimConflict } from "../provider.ts";
import { AzureDevOpsApiError, AzureDevOpsClient } from "./client.ts";
import type { AzureDevOpsClientOptions } from "./client.ts";

const PROTOCOL = "ensemble-azure-devops-state/v1";
const TOOL_MARKER = "<!-- ensemble-agent-tool:v1:";
const EFFECT_MARKER = "<!-- ensemble-side-effect:v1:";
const TOOL_ITEM_LIMIT = 100;
const TOOL_TEXT_LIMIT = 8_192;
const TOOL_RESULT_BUDGET = 196_608;
const COMMENTS_API_VERSION = "7.1-preview.4";
const failureKinds = new Set<FailureKind>([
  "startup", "provider", "configuration", "runtime", "timeout", "stalled", "reconciliation", "shutdown",
]);

export interface AzureDevOpsNativeStates {
  readonly ready: string;
  readonly running: string;
  readonly blocked: string;
  readonly failed: string;
  readonly completed: string;
}

export interface AzureDevOpsProviderOptions extends AzureDevOpsClientOptions {
  readonly queryId: string;
  readonly stateField: string;
  readonly repository: RepositoryRef;
  readonly nativeStates: AzureDevOpsNativeStates;
  readonly priorityField?: string;
  readonly requiredTags?: readonly string[];
  readonly requiredAssignee?: string;
  readonly blockerRelation?: string;
  readonly acceptanceCriteriaField?: string;
  readonly executionId?: () => string;
  readonly now?: () => Date;
  readonly inventoryMaxItems?: number;
}

interface AzureIdentity { readonly displayName?: string; readonly uniqueName?: string; readonly id?: string }
interface AzureRelation { readonly rel?: string; readonly url?: string; readonly attributes?: Readonly<Record<string, unknown>> }
interface AzureWorkItem {
  readonly id?: number;
  readonly rev?: number;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly relations?: readonly AzureRelation[];
  readonly url?: string;
}
interface AzureComment {
  readonly id?: number;
  readonly commentId?: number;
  readonly text?: string;
  readonly createdDate?: string;
  readonly createdBy?: AzureIdentity;
  readonly isDeleted?: boolean;
}
interface ProviderEvent {
  readonly kind: "claim" | "lease" | "complete" | "fail" | "cancel" | "block" | "artifact";
  readonly executionId: string;
  readonly createdAt: string;
  readonly role?: string;
  readonly expected?: ExecutionLeaseBasis;
  readonly ownerId?: string;
  readonly leaseExpiresAt?: string;
  readonly observedAt?: string;
  readonly record?: ExecutionRecord;
  readonly comments?: readonly string[];
  readonly artifacts?: readonly Artifact[];
}
interface PersistedState {
  readonly protocol: typeof PROTOCOL;
  readonly repositoryId: string;
  readonly events: readonly ProviderEvent[];
}
interface PersistedStateEnvelope {
  readonly repositoryId: string;
  readonly events: readonly unknown[];
}
interface FoldedState {
  readonly state: ProviderExecutionState;
  readonly terminals: ReadonlyMap<string, ProviderEvent>;
}
interface QueriedItems {
  readonly items: readonly AzureWorkItem[];
  readonly savedIds: ReadonlySet<number>;
  readonly complete: boolean;
}

const DEFAULT_FIELDS = [
  "System.Id", "System.Title", "System.Description", "System.State", "System.Tags", "System.AssignedTo",
];

/** Azure DevOps Services REST 7.1 provider backed by a revision-guarded custom work-item field. */
export class AzureDevOpsProvider implements ProviderAdapter {
  readonly name = "azure-devops";
  readonly client: AzureDevOpsClient;
  readonly queryId: string;
  readonly stateField: string;
  readonly repository: RepositoryRef;
  readonly nativeStates: AzureDevOpsNativeStates;
  readonly priorityField?: string;
  readonly requiredTags: readonly string[];
  readonly requiredAssignee?: string;
  readonly blockerRelation: string;
  readonly acceptanceCriteriaField: string;
  readonly #executionId: () => string;
  readonly #now: () => Date;
  readonly #inventoryMaxItems: number;
  readonly #toolMutations = new Map<string, Promise<void>>();

  constructor(options: AzureDevOpsProviderOptions) {
    this.repository = Object.freeze({ ...options.repository });
    this.client = new AzureDevOpsClient({ ...options, repositoryId: this.repository.id });
    this.queryId = requiredString(options.queryId, "saved query ID");
    this.stateField = fieldName(options.stateField, "stateField");
    this.nativeStates = Object.freeze({ ...options.nativeStates });
    assertDistinctStates(this.nativeStates);
    this.priorityField = options.priorityField === undefined ? undefined : fieldName(options.priorityField, "priorityField");
    this.requiredTags = Object.freeze([...new Set(options.requiredTags ?? [])].sort());
    this.requiredAssignee = options.requiredAssignee;
    this.blockerRelation = requiredString(options.blockerRelation ?? "System.LinkTypes.Dependency-Reverse", "blocker relation");
    this.acceptanceCriteriaField = fieldName(options.acceptanceCriteriaField ?? "Microsoft.VSTS.Common.AcceptanceCriteria", "acceptanceCriteriaField");
    this.#executionId = options.executionId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#inventoryMaxItems = positiveInteger(options.inventoryMaxItems ?? 10_000, "inventoryMaxItems");
  }

  async validateConfiguration(): Promise<void> {
    const query = await this.client.request<unknown>("GET", `_apis/wit/queries/${encodeURIComponent(this.queryId)}?$expand=wiql`);
    if (!query || typeof query !== "object" || typeof (query as { wiql?: unknown }).wiql !== "string") {
      throw new Error(`Azure DevOps saved query is not executable: ${this.queryId}`);
    }
    const queryType = (query as { queryType?: unknown }).queryType;
    if (typeof queryType === "string" && queryType.toLocaleLowerCase() !== "flat") {
      throw new Error(`Azure DevOps saved query must be flat: ${this.queryId}`);
    }
    const field = await this.client.request<unknown>("GET", `_apis/wit/fields/${encodeURIComponent(this.stateField)}`);
    if (!field || typeof field !== "object" || (field as { referenceName?: unknown }).referenceName !== this.stateField) {
      throw new Error(`Azure DevOps state field does not exist: ${this.stateField}`);
    }
    if ((field as { type?: unknown }).type !== "plainText") {
      throw new Error(`Azure DevOps state field must be plainText: ${this.stateField}`);
    }
  }

  async inventoryTasks(): Promise<ProviderTaskInventory> {
    const queried = await this.#queryItems();
    const selected = queried.items.filter((item) => queried.savedIds.has(requiredNumber(item.id, "work item id"))
      || stateBelongsToRepository(item.fields?.[this.stateField], this.repository.id));
    const tasks = await this.#normalizeItems(selected);
    return Object.freeze({
      completeness: queried.complete ? "complete" : "partial",
      entries: Object.freeze(tasks.map((task) => Object.freeze({
        task, lifecycle: task.status === "completed" ? "terminal" as const : "current" as const,
      }))),
    });
  }

  async discoverTasks(query: TaskQuery): Promise<readonly Task[]> {
    if (query.scope !== "workflow_candidates") throw new Error(`Unsupported task query scope: ${String(query.scope)}`);
    const queried = await this.#queryItems();
    const activeIds = new Set<number>();
    const selected = queried.items.filter((item) => {
      const id = requiredNumber(item.id, "work item id");
      if (queried.savedIds.has(id)) {
        if (foldState(parseState(item.fields?.[this.stateField], this.repository.id).events).state.active) activeIds.add(id);
        return true;
      }
      if (!stateBelongsToRepository(item.fields?.[this.stateField], this.repository.id)) return false;
      const active = foldState(parseState(item.fields?.[this.stateField], this.repository.id).events).state.active;
      if (active) activeIds.add(id);
      return active !== undefined;
    });
    const tasks = await this.#normalizeItems(selected);
    return Object.freeze(tasks.filter((task) => (queried.savedIds.has(taskNumber(task.id))
      && task.dispatchable && (task.status === "ready" || task.status === "failed")) || activeIds.has(taskNumber(task.id)))
      .sort(compareTasks));
  }

  async refreshTasks(ids: readonly TaskId[]): Promise<ReadonlyMap<TaskId, TaskRefreshResult>> {
    const ordered = [...new Set(ids)].sort(compareTaskIds);
    const result = new Map<TaskId, TaskRefreshResult>();
    let raw: readonly AzureWorkItem[];
    try { raw = await this.client.workItemsBatch<AzureWorkItem>(ordered.map(taskNumber), this.#fields()); }
    catch (error) {
      for (const id of ordered) result.set(id, { kind: "unreadable", error: safeError(error) });
      return result;
    }
    const returnedIds = new Set(raw.map((item) => String(requiredNumber(validateWorkItem(item).id, "work item id"))));
    const recovered: AzureWorkItem[] = [];
    const omitted = new Map<TaskId, TaskRefreshResult>();
    for (const id of ordered) {
      if (returnedIds.has(id)) continue;
      try { recovered.push(await this.#getRawItem(id)); }
      catch (error) {
        omitted.set(id, error instanceof AzureDevOpsApiError && error.status === 404
          ? { kind: "missing" }
          : { kind: "unreadable", error: safeError(error) });
      }
    }
    const normalized = await this.#normalizeItems([...raw, ...recovered]);
    const byId = new Map(normalized.map((task) => [task.id, task]));
    for (const id of ordered) result.set(id, byId.has(id) ? { kind: "current", task: byId.get(id)! } : omitted.get(id)!);
    return result;
  }

  async getTask(id: TaskId): Promise<Task> {
    const item = validateWorkItem(await this.client.request<unknown>("GET", `_apis/wit/workitems/${taskNumber(id)}?$expand=relations`));
    return (await this.#normalizeItems([item]))[0]!;
  }

  async getComments(id: TaskId): Promise<readonly TaskComment[]> {
    const [native, item] = await Promise.all([this.#comments(id), this.#getRawItem(id)]);
    const ordinary = native.flatMap((comment): TaskComment[] => {
      const body = requiredString(comment.text, "comment text");
      if (body.startsWith(EFFECT_MARKER)) return [];
      return [Object.freeze({
        id: String(commentId(comment)), body: stripToolMarker(body),
        ...(identityName(comment.createdBy) ? { author: identityName(comment.createdBy)! } : {}),
        createdAt: canonicalTimestamp(comment.createdDate, "comment created date"),
      })];
    });
    const terminal = [...foldState(parseState(item.fields?.[this.stateField], this.repository.id).events).terminals.values()]
      .flatMap((event) => (event.comments ?? []).map((body, index) => Object.freeze({
        id: `${event.executionId}:comment:${index}`, body,
        createdAt: canonicalTimestamp(event.record?.finishedAt, "terminal comment date"),
      })));
    return Object.freeze([...ordinary, ...terminal].sort(compareComments));
  }

  async getArtifacts(id: TaskId): Promise<readonly Artifact[]> {
    const state = parseState((await this.#getRawItem(id)).fields?.[this.stateField], this.repository.id);
    return Object.freeze(state.events.flatMap((event) => event.artifacts ?? []).map((artifact) => Object.freeze({ ...artifact })));
  }

  async getRuntimeTools(id: TaskId, executionId: string, ownerId: string): Promise<readonly RuntimeTool[]> {
    await this.#assertActive(id, executionId, ownerId);
    const empty = Object.freeze({ type: "object", properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false } as const);
    const tools: RuntimeTool[] = [
      { name: "task_read", description: "Read the claimed Azure DevOps work item.", inputSchema: empty,
        invoke: async () => this.#invokeTool("task_read", async () => { await this.#assertActive(id, executionId, ownerId); return boundedTask(await this.getTask(id)); }) },
      { name: "task_comments_read", description: "Read bounded Azure DevOps work item comments.", inputSchema: empty,
        invoke: async () => this.#invokeTool("task_comments_read", async () => { await this.#assertActive(id, executionId, ownerId); return boundedCollection((await this.getComments(id)).slice(-TOOL_ITEM_LIMIT), boundedComment); }) },
      { name: "task_artifacts_read", description: "Read bounded artifact references.", inputSchema: empty,
        invoke: async () => this.#invokeTool("task_artifacts_read", async () => { await this.#assertActive(id, executionId, ownerId); return boundedCollection((await this.getArtifacts(id)).slice(-TOOL_ITEM_LIMIT), boundedArtifact); }) },
      { name: "task_comment_add", description: "Add an idempotent Azure DevOps work item comment.", inputSchema: Object.freeze({
          type: "object", properties: Object.freeze({ body: Object.freeze({ type: "string" }), idempotencyKey: Object.freeze({ type: "string" }) }),
          required: Object.freeze(["body", "idempotencyKey"]), additionalProperties: false,
        }), invoke: async (input) => this.#invokeTool("task_comment_add", async () => {
          const values = toolCommentInput(input);
          return this.#serializeToolMutation(`${id}:${executionId}:${values.idempotencyKey}`, async () => {
            await this.#assertActive(id, executionId, ownerId);
            const marker = toolMarker(executionId, values.idempotencyKey);
            const existing = await this.#reconcileMarkedComment(id, marker);
            if (existing) {
              if (existing.text !== `${marker}\n${values.body}`) throw new Error("Conflicting comment tool idempotency key");
              return boundedComment(normalizeComment(existing));
            }
            await this.#createRawComment(id, `${marker}\n${values.body}`);
            const durable = await this.#reconcileMarkedComment(id, marker);
            if (!durable || durable.text !== `${marker}\n${values.body}`) throw new Error("Azure DevOps tool comment was not durable");
            return boundedComment(normalizeComment(durable));
          });
        }) },
    ];
    return Object.freeze(tools.map((tool) => Object.freeze(tool)));
  }

  async getExecutionState(id: TaskId): Promise<ProviderExecutionState> {
    return foldState(parseState((await this.#getRawItem(id)).fields?.[this.stateField], this.repository.id).events).state;
  }

  async inspectTask(id: TaskId, options: { readonly includeJournal?: boolean } = {}): Promise<ProviderTaskDiagnostic> {
    const [task, rawComments, raw] = await Promise.all([this.getTask(id), this.#comments(id), this.#getRawItem(id)]);
    const events = parseState(raw.fields?.[this.stateField], this.repository.id).events;
    const execution = foldState(events).state;
    return Object.freeze({
      task: Object.freeze({ id: boundedText(task.id, 256), title: boundedText(task.title, 1_024), status: task.status,
        ...(task.dispatchable === undefined ? {} : { dispatchable: task.dispatchable }), labels: task.labels, assignees: task.assignees,
        ...(task.blockers ? { blockers: task.blockers } : {}) }),
      execution: diagnosticExecution(execution),
      commentCount: rawComments.filter((comment) => !comment.text?.startsWith(EFFECT_MARKER)).length
        + events.reduce((count, event) => count + (event.comments?.length ?? 0), 0),
      artifactCount: events.reduce((count, event) => count + (event.artifacts?.length ?? 0), 0),
      ...(options.includeJournal ? { journal: diagnosticJournal(events) } : {}),
    });
  }

  async updateStatus(id: TaskId, status: string): Promise<void> {
    const native = nativeState(status, this.nativeStates);
    const item = await this.#getRawItem(id);
    await this.client.patch(`_apis/wit/workitems/${taskNumber(id)}`, [
      { op: "test", path: "/rev", value: item.rev },
      { op: "add", path: "/fields/System.State", value: native },
    ]);
  }

  async createComment(id: TaskId, body: string): Promise<TaskComment> {
    return this.#createRawComment(id, body);
  }

  async uploadArtifact(id: TaskId, artifact: Artifact): Promise<Artifact> {
    await this.#appendEvent(id, { kind: "artifact", executionId: `artifact:${this.#executionId()}`,
      createdAt: this.#now().toISOString(), artifacts: [artifact] });
    return Object.freeze({ ...artifact });
  }

  async beginExecution(id: TaskId, role: string, runningStatus: string, lease: ExecutionLeaseClaim): Promise<ActiveExecution> {
    validateLeaseClaim(lease);
    const item = await this.#getRawItem(id);
    const persisted = parseState(item.fields?.[this.stateField], this.repository.id);
    const before = foldState(persisted.events).state;
    if (before.active?.ownerId === lease.ownerId && before.active.leaseExpiresAt === lease.expiresAt) return before.active;
    assertLeaseBasis(id, lease.expected, before.active);
    if (before.active?.ownerId && before.active.leaseExpiresAt && before.active.ownerId !== lease.ownerId
      && Date.parse(before.active.leaseExpiresAt) > Date.parse(lease.observedAt)) throw new ProviderClaimConflict(id, before.active);
    const event: ProviderEvent = Object.freeze({ kind: "claim", executionId: before.active?.id ?? this.#executionId(),
      role: before.active?.role ?? role, expected: lease.expected, ownerId: lease.ownerId, leaseExpiresAt: lease.expiresAt,
      observedAt: lease.observedAt, createdAt: this.#now().toISOString() });
    try { await this.#patchState(item, [...persisted.events, event], runningStatus, `Ensemble claimed ${event.executionId}`); }
    catch (error) { return this.#resolveClaimConflict(id, event, error); }
    const active = foldState([...persisted.events, event]).state.active;
    if (!active) throw new Error(`Azure DevOps claim ${event.executionId} was not durable`);
    return active;
  }

  async renewExecutionLease(id: TaskId, executionId: string, lease: ExecutionLeaseClaim): Promise<ActiveExecution> {
    validateLeaseClaim(lease);
    const item = await this.#getRawItem(id);
    const persisted = parseState(item.fields?.[this.stateField], this.repository.id);
    const before = foldState(persisted.events).state;
    assertLeaseBasis(id, lease.expected, before.active);
    if (!before.active || before.active.id !== executionId || before.active.ownerId !== lease.ownerId
      || !before.active.leaseExpiresAt || Date.parse(before.active.leaseExpiresAt) <= Date.parse(lease.observedAt)
      || Date.parse(lease.expiresAt) <= Date.parse(before.active.leaseExpiresAt)) {
      if (before.active) throw new ProviderClaimConflict(id, before.active);
      throw new Error(`Execution is not active: ${executionId}`);
    }
    const event: ProviderEvent = Object.freeze({ kind: "lease", executionId, role: before.active.role, expected: lease.expected,
      ownerId: lease.ownerId, leaseExpiresAt: lease.expiresAt, observedAt: lease.observedAt, createdAt: this.#now().toISOString() });
    const events = compactLeaseRenewal(persisted.events, event);
    try { await this.#patchState(item, events, undefined, `Ensemble renewed ${executionId}`); }
    catch (error) { throw await this.#claimError(id, error); }
    return foldState(events).state.active!;
  }

  async completeExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, completion: ExecutionCompletion): Promise<void> {
    await this.#finish(id, executionId, lease, "complete", completion);
  }

  async failExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, record: ExecutionRecord, status: string, comment: string): Promise<void> {
    await this.#finish(id, executionId, lease, "fail", { record, status, comments: [comment], artifacts: [] });
  }

  async cancelExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, cancellation: ExecutionCancellation): Promise<void> {
    await this.#finish(id, executionId, lease, "cancel", { record: cancellation.record, status: cancellation.status,
      comments: [cancellation.comment], artifacts: [] });
  }

  async blockExecution(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, cancellation: ExecutionCancellation): Promise<void> {
    await this.#finish(id, executionId, lease, "block", { record: cancellation.record, status: cancellation.status,
      comments: [cancellation.comment], artifacts: [] });
  }

  async #finish(id: TaskId, executionId: string, lease: ExecutionLeaseGuard, kind: "complete" | "fail" | "cancel" | "block", completion: ExecutionCompletion): Promise<void> {
    const item = await this.#getRawItem(id);
    const persisted = parseState(item.fields?.[this.stateField], this.repository.id);
    const folded = foldState(persisted.events);
    const existing = folded.terminals.get(executionId);
    if (existing) {
      if (!sameTerminal(existing, completion)) throw new Error(`Conflicting execution record: ${executionId}`);
      await this.#repairTerminalEffects(id, existing);
      return;
    }
    if (!folded.state.active || folded.state.active.id !== executionId) throw new Error(`Execution is not active: ${executionId}`);
    assertLeaseGuard(id, folded.state.active, lease);
    const event: ProviderEvent = Object.freeze({ kind, executionId, role: completion.record.role,
      createdAt: completion.record.finishedAt, record: validateRecord(completion.record), comments: Object.freeze([...completion.comments]),
      artifacts: Object.freeze(completion.artifacts.map((artifact) => Object.freeze({ ...artifact }))), ownerId: lease.ownerId,
      leaseExpiresAt: lease.leaseExpiresAt, observedAt: lease.observedAt });
    try { await this.#patchState(item, [...persisted.events, event], completion.status, `Ensemble ${kind} ${executionId}`); }
    catch (error) {
      const latest = foldState(parseState((await this.#getRawItem(id)).fields?.[this.stateField], this.repository.id).events);
      const recorded = latest.terminals.get(executionId);
      if (!recorded || !sameTerminal(recorded, completion)) throw await this.#claimError(id, error);
    }
    await this.#repairTerminalEffects(id, event);
  }

  async #repairTerminalEffects(id: TaskId, event: ProviderEvent): Promise<void> {
    for (const [index, body] of (event.comments ?? []).entries()) {
      const marker = effectMarker(event.executionId, index);
      const found = await this.#reconcileMarkedComment(id, marker);
      if (found && found.text !== `${marker}\n${body}`) throw new Error(`Conflicting terminal comment: ${event.executionId}`);
      if (!found) await this.#createRawComment(id, `${marker}\n${body}`);
      const durable = await this.#reconcileMarkedComment(id, marker);
      if (!durable || durable.text !== `${marker}\n${body}`) throw new Error(`Azure DevOps terminal comment was not durable: ${event.executionId}`);
    }
  }

  async #resolveClaimConflict(id: TaskId, attempted: ProviderEvent, error: unknown): Promise<ActiveExecution> {
    const state = await this.getExecutionState(id);
    if (state.active?.id === attempted.executionId && state.active.ownerId === attempted.ownerId
      && state.active.leaseExpiresAt === attempted.leaseExpiresAt) return state.active;
    if (state.active) throw new ProviderClaimConflict(id, state.active);
    throw error;
  }

  async #claimError(id: TaskId, error: unknown): Promise<Error> {
    if (isRevisionConflict(error)) {
      const active = (await this.getExecutionState(id)).active;
      if (active) return new ProviderClaimConflict(id, active);
    }
    return error instanceof Error ? error : new Error("Azure DevOps provider mutation failed");
  }

  async #appendEvent(id: TaskId, event: ProviderEvent): Promise<void> {
    const item = await this.#getRawItem(id);
    const state = parseState(item.fields?.[this.stateField], this.repository.id);
    await this.#patchState(item, [...state.events, event], undefined, `Ensemble recorded ${event.kind}`);
  }

  async #patchState(item: AzureWorkItem, events: readonly ProviderEvent[], status?: string, history?: string): Promise<void> {
    const operations: Array<Readonly<Record<string, unknown>>> = [
      { op: "test", path: "/rev", value: requiredNumber(item.rev, "work item revision") },
      { op: "add", path: `/fields/${jsonPointer(this.stateField)}`,
        value: JSON.stringify({ protocol: PROTOCOL, repositoryId: this.repository.id, events }) },
    ];
    if (status !== undefined) operations.push({ op: "add", path: "/fields/System.State", value: nativeState(status, this.nativeStates) });
    if (history !== undefined) operations.push({ op: "add", path: "/fields/System.History", value: history });
    await this.client.patch(`_apis/wit/workitems/${requiredNumber(item.id, "work item id")}`, operations);
  }

  async #queryItems(): Promise<QueriedItems> {
    const top = this.#inventoryMaxItems + 1;
    const [savedPayload, statePayload] = await Promise.all([
      this.client.request<unknown>("GET", `_apis/wit/wiql/${encodeURIComponent(this.queryId)}?$top=${top}`),
      this.client.read<unknown>("POST", `_apis/wit/wiql?$top=${top}`, {
        query: `SELECT [System.Id] FROM WorkItems WHERE [${this.stateField}] IS NOT EMPTY`,
      }),
    ]);
    const savedIds = flatQueryIds(savedPayload, "saved query");
    const stateIds = flatQueryIds(statePayload, "state query");
    if (savedIds.length > this.#inventoryMaxItems) throw new Error("Azure DevOps saved query item limit exceeded");
    if (stateIds.length > this.#inventoryMaxItems) throw new Error("Azure DevOps state query item limit exceeded");
    const ids = [...new Set([...savedIds, ...stateIds])].sort((left, right) => left - right);
    if (ids.length > this.#inventoryMaxItems) throw new Error("Azure DevOps managed item limit exceeded");
    const raw = await this.client.workItemsBatch<AzureWorkItem>(ids, this.#fields());
    const byId = new Map<number, AzureWorkItem>();
    const expected = new Set(ids);
    for (const value of raw) {
      const item = validateWorkItem(value);
      const id = requiredNumber(item.id, "work item id");
      if (!expected.has(id)) throw new Error(`Azure DevOps work item batch returned unexpected item: ${id}`);
      if (byId.has(id)) throw new Error(`Azure DevOps work item batch returned duplicate item: ${id}`);
      byId.set(id, item);
    }
    return Object.freeze({ items: Object.freeze([...byId.values()].sort((left, right) => left.id! - right.id!)),
      savedIds: new Set(savedIds), complete: byId.size === ids.length });
  }

  #fields(): readonly string[] {
    return Object.freeze([...new Set([...DEFAULT_FIELDS, this.stateField, this.acceptanceCriteriaField,
      ...(this.priorityField ? [this.priorityField] : [])])]);
  }

  async #normalizeItems(values: readonly AzureWorkItem[]): Promise<readonly Task[]> {
    const items = values.map(validateWorkItem).sort((left, right) => requiredNumber(left.id, "work item id") - requiredNumber(right.id, "work item id"));
    const blockerIds = [...new Set(items.flatMap((item) => blockerReferences(item, this.blockerRelation).map((blocker) => blocker.id)))];
    const blockerItems = blockerIds.length === 0 ? [] : await this.client.workItemsBatch<AzureWorkItem>(blockerIds, ["System.Id", "System.State"], "None");
    const blockerStates = new Map(blockerItems.map((item) => [requiredNumber(item.id, "blocker id"),
      requiredString(item.fields?.["System.State"], "blocker state")]));
    return Object.freeze(items.map((item) => this.#normalizeItem(item, blockerStates)));
  }

  #normalizeItem(item: AzureWorkItem, blockerStates: ReadonlyMap<number, string>): Task {
    const fields = item.fields!;
    const id = String(item.id);
    const tags = tagsFrom(fields["System.Tags"]);
    const assignee = identityName(fields["System.AssignedTo"]);
    const assignees = assignee ? [assignee] : [];
    const blockers: TaskBlocker[] = blockerReferences(item, this.blockerRelation).map(({ id: blockerId }) => {
      const native = blockerStates.get(blockerId);
      return Object.freeze({ id: String(blockerId), ...(native ? { status: portableStatus(native, this.nativeStates) } : {}),
        resolved: native === this.nativeStates.completed });
    });
    const native = requiredString(fields["System.State"], "work item state");
    const persisted = parseState(fields[this.stateField], this.repository.id);
    const active = foldState(persisted.events).state.active;
    const status = active && portableStatus(native, this.nativeStates) === "unmanaged" ? "running" : portableStatus(native, this.nativeStates);
    const dispatchable = status !== "completed" && this.requiredTags.every((tag) => tags.includes(tag))
      && (this.requiredAssignee === undefined || assignees.some((value) => value.toLocaleLowerCase() === this.requiredAssignee!.toLocaleLowerCase()))
      && blockers.every((blocker) => blocker.resolved);
    const priority = this.priorityField === undefined ? undefined : optionalFiniteNumber(fields[this.priorityField]);
    return Object.freeze({
      id, title: requiredString(fields["System.Title"], "work item title"),
      description: plainText(fields["System.Description"]),
      acceptanceCriteria: Object.freeze(acceptanceCriteria(fields[this.acceptanceCriteriaField])),
      status, labels: Object.freeze(tags), assignees: Object.freeze(assignees), dispatchable,
      ...(priority === undefined ? {} : { priority }), blockers: Object.freeze(blockers), repository: this.repository,
    });
  }

  async #getRawItem(id: TaskId): Promise<AzureWorkItem> {
    return validateWorkItem(await this.client.request<unknown>("GET", `_apis/wit/workitems/${taskNumber(id)}?$expand=relations`));
  }

  async #comments(id: TaskId): Promise<readonly AzureComment[]> {
    return this.client.continuation<AzureComment>(
      `_apis/wit/workitems/${taskNumber(id)}/comments?$top=200&api-version=${COMMENTS_API_VERSION}`,
      (payload) => {
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as { comments?: unknown }).comments)) {
        throw new Error(`Azure DevOps comments for work item ${id} are invalid`);
      }
      const page = payload as { comments: unknown[]; continuationToken?: unknown };
      return { items: page.comments.map(validateComment),
        ...(typeof page.continuationToken === "string" && page.continuationToken ? { continuationToken: page.continuationToken } : {}) };
      }, { maxPages: 100, maxItems: 10_000 });
  }

  async #createRawComment(id: TaskId, body: string): Promise<TaskComment> {
    const comment = validateComment(await this.client.request<unknown>("POST",
      `_apis/wit/workitems/${taskNumber(id)}/comments?api-version=${COMMENTS_API_VERSION}`, { text: body }));
    return normalizeComment(comment);
  }

  async #reconcileMarkedComment(id: TaskId, marker: string): Promise<AzureComment | undefined> {
    const matches = (await this.#comments(id)).filter((comment) => comment.text?.startsWith(`${marker}\n`))
      .sort((left, right) => commentId(left) - commentId(right));
    const winner = matches[0];
    for (const duplicate of matches.slice(1)) {
      try { await this.client.request("DELETE",
        `_apis/wit/workitems/${taskNumber(id)}/comments/${commentId(duplicate)}?api-version=${COMMENTS_API_VERSION}`); }
      catch (error) { if (!(error instanceof AzureDevOpsApiError && error.status === 404)) throw error; }
    }
    return winner;
  }

  async #assertActive(id: TaskId, executionId: string, ownerId: string): Promise<void> {
    const active = (await this.getExecutionState(id)).active;
    if (active?.id !== executionId || active.ownerId !== ownerId) throw new Error("Azure DevOps tool execution is no longer active");
  }

  async #invokeTool<T extends PortableJsonValue>(name: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch { throw new Error(`Azure DevOps tool ${name} failed`); }
  }

  async #serializeToolMutation<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#toolMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#toolMutations.set(key, queued);
    await previous;
    try { return await work(); } finally { release(); if (this.#toolMutations.get(key) === queued) this.#toolMutations.delete(key); }
  }
}

function parseState(value: unknown, repositoryId: string): PersistedState {
  if (value === undefined || value === null || value === "") {
    return Object.freeze({ protocol: PROTOCOL, repositoryId, events: Object.freeze([]) });
  }
  const envelope = decodeStateEnvelope(value);
  if (envelope.repositoryId !== repositoryId) {
    throw new Error(`Azure DevOps provider state belongs to another repository: ${envelope.repositoryId}`);
  }
  return Object.freeze({ protocol: PROTOCOL, repositoryId,
    events: Object.freeze(envelope.events.map(validateEvent)) });
}

function stateBelongsToRepository(value: unknown, repositoryId: string): boolean {
  if (value === undefined || value === null || value === "") return false;
  return decodeStateEnvelope(value).repositoryId === repositoryId;
}

function decodeStateEnvelope(value: unknown): PersistedStateEnvelope {
  if (typeof value !== "string") throw new Error("Invalid Azure DevOps provider state field");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Malformed Azure DevOps provider state field"); }
  if (!parsed || typeof parsed !== "object" || (parsed as { protocol?: unknown }).protocol !== PROTOCOL
    || typeof (parsed as { repositoryId?: unknown }).repositoryId !== "string"
    || !(parsed as { repositoryId: string }).repositoryId.trim()
    || !Array.isArray((parsed as { events?: unknown }).events)) throw new Error("Invalid Azure DevOps provider state field");
  return Object.freeze({ repositoryId: (parsed as { repositoryId: string }).repositoryId,
    events: Object.freeze([...(parsed as { events: unknown[] }).events]) });
}

function flatQueryIds(payload: unknown, source: string): readonly number[] {
  if (!payload || typeof payload !== "object") throw new Error(`Azure DevOps ${source} response is invalid`);
  const value = payload as { queryType?: unknown; queryResultType?: unknown; workItems?: unknown; workItemRelations?: unknown };
  if ((typeof value.queryType === "string" && value.queryType.toLocaleLowerCase() !== "flat")
    || (typeof value.queryResultType === "string" && value.queryResultType.toLocaleLowerCase() !== "workitem")
    || value.workItemRelations !== undefined || !Array.isArray(value.workItems)) {
    throw new Error(`Azure DevOps ${source} response has no flat work item list`);
  }
  return Object.freeze([...new Set(value.workItems.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid Azure DevOps ${source} work item`);
    return positiveInteger(requiredNumber((entry as { id?: unknown }).id, "query work item id"), "query work item id");
  }))].sort((left, right) => left - right));
}

function foldState(events: readonly ProviderEvent[]): FoldedState {
  let active: ActiveExecution | undefined;
  const records = new Map<string, ExecutionRecord>();
  const terminals = new Map<string, ProviderEvent>();
  for (const event of events) {
    if (event.kind === "artifact") continue;
    if (event.kind === "claim") {
      if (!event.expected || !basisMatches(event.expected, active)) continue;
      const observed = Date.parse(event.observedAt!);
      if (active?.ownerId && active.leaseExpiresAt && active.ownerId !== event.ownerId && Date.parse(active.leaseExpiresAt) > observed) continue;
      active = Object.freeze({ id: active?.id ?? event.executionId, role: active?.role ?? event.role!,
        startedAt: active?.startedAt ?? canonicalTimestamp(event.createdAt, "claim created date"), ownerId: event.ownerId,
        leaseExpiresAt: event.leaseExpiresAt });
      continue;
    }
    if (event.kind === "lease") {
      if (!event.expected || !basisMatches(event.expected, active) || active?.id !== event.executionId
        || active.ownerId !== event.ownerId || !active.leaseExpiresAt
        || Date.parse(active.leaseExpiresAt) <= Date.parse(event.observedAt!)
        || Date.parse(event.leaseExpiresAt!) <= Date.parse(active.leaseExpiresAt)) continue;
      active = Object.freeze({ ...active, leaseExpiresAt: event.leaseExpiresAt });
      continue;
    }
    if (!event.record) continue;
    if (!active || active.id !== event.executionId || (active.ownerId && (active.ownerId !== event.ownerId
      || active.leaseExpiresAt !== event.leaseExpiresAt || Date.parse(event.leaseExpiresAt!) <= Date.parse(event.observedAt!)))) continue;
    if (!records.has(event.executionId)) { records.set(event.executionId, event.record); terminals.set(event.executionId, event); }
    active = undefined;
  }
  const history = [...records.values()].sort(compareRecords).map(freezeRecord);
  return Object.freeze({ state: Object.freeze({ ...(active ? { active } : {}), history: Object.freeze(history),
    ...(history.at(-1)?.nextRole ? { nextRole: history.at(-1)!.nextRole } : {}) }), terminals });
}

function compactLeaseRenewal(events: readonly ProviderEvent[], renewal: ProviderEvent): readonly ProviderEvent[] {
  let claimIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "claim" && event.executionId === renewal.executionId) {
      claimIndex = index;
      break;
    }
  }
  const priorLease = events.slice(claimIndex + 1)
    .find((event) => event.kind === "lease" && event.executionId === renewal.executionId);
  const compacted = events.filter((event, index) => index <= claimIndex
    || event.kind !== "lease" || event.executionId !== renewal.executionId);
  return Object.freeze([...compacted, Object.freeze(priorLease
    ? { ...renewal, expected: priorLease.expected, observedAt: priorLease.observedAt, createdAt: priorLease.createdAt }
    : renewal)]);
}

function validateEvent(value: unknown): ProviderEvent {
  if (!value || typeof value !== "object") throw new Error("Invalid Azure DevOps provider event");
  const event = value as Partial<ProviderEvent>;
  if (!event.kind || !["claim", "lease", "complete", "fail", "cancel", "block", "artifact"].includes(event.kind)
    || typeof event.executionId !== "string" || !event.executionId || !isCanonicalTimestamp(event.createdAt)) throw new Error("Invalid Azure DevOps provider event");
  if ((event.kind === "claim" || event.kind === "lease") && (!event.expected || !event.ownerId
    || !isCanonicalTimestamp(event.observedAt) || !isCanonicalTimestamp(event.leaseExpiresAt))) throw new Error("Invalid Azure DevOps lease event");
  if (event.kind === "claim" && !event.role) throw new Error("Invalid Azure DevOps claim event");
  validateLeaseBasis(event.expected);
  if (isTerminal(event.kind)) {
    if (!event.record || event.record.id !== event.executionId) throw new Error("Invalid Azure DevOps terminal event");
    validateRecord(event.record);
  }
  if (event.comments !== undefined && (!Array.isArray(event.comments) || event.comments.some((item) => typeof item !== "string"))) throw new Error("Invalid Azure DevOps event comments");
  if (event.artifacts !== undefined && (!Array.isArray(event.artifacts) || event.artifacts.some((item) => !item || typeof item.type !== "string" || typeof item.url !== "string"))) throw new Error("Invalid Azure DevOps event artifacts");
  return Object.freeze({ ...event }) as ProviderEvent;
}

function validateRecord(record: ExecutionRecord): ExecutionRecord {
  if (!record || typeof record.id !== "string" || !record.id || typeof record.role !== "string" || !record.role
    || typeof record.outcome !== "string" || typeof record.summary !== "string" || !isCanonicalTimestamp(record.finishedAt)
    || (record.nextRole !== undefined && typeof record.nextRole !== "string") || (record.failure !== undefined && !validFailure(record.failure))) {
    throw new Error("Invalid Azure DevOps execution record");
  }
  const request = record.blockingRequest;
  if ((record.outcome === "blocked") !== (request !== undefined)) throw new Error("Invalid Azure DevOps execution record");
  if (request && ((request.kind !== "approval" && request.kind !== "user_input" && request.kind !== "tool_elicitation")
    || !request.summary.trim() || !isCanonicalTimestamp(request.createdAt) || (request.requestId !== undefined && !request.requestId.trim()))) {
    throw new Error("Invalid Azure DevOps blocking request");
  }
  return freezeRecord(record);
}

function validFailure(value: NonNullable<ExecutionRecord["failure"]>): boolean {
  return failureKinds.has(value.kind) && typeof value.retryable === "boolean"
    && (value.retryable ? isCanonicalTimestamp(value.nextAttemptAt) : value.nextAttemptAt === undefined);
}

function validateLeaseClaim(lease: ExecutionLeaseClaim): void {
  if (!lease.ownerId.trim() || !isCanonicalTimestamp(lease.observedAt) || !isCanonicalTimestamp(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= Date.parse(lease.observedAt)) throw new Error("Invalid execution lease claim");
  validateLeaseBasis(lease.expected);
}

function validateLeaseBasis(basis: ExecutionLeaseBasis | undefined): void {
  if (basis === undefined || basis.kind === "none") return;
  if (!basis.executionId || !basis.role || !isCanonicalTimestamp(basis.startedAt)) throw new Error("Invalid execution lease basis");
  if (basis.kind === "leased" && (!basis.ownerId || !isCanonicalTimestamp(basis.leaseExpiresAt))) throw new Error("Invalid execution lease basis");
}

function basisMatches(basis: ExecutionLeaseBasis, active: ActiveExecution | undefined): boolean {
  if (basis.kind === "none") return active === undefined;
  if (!active || basis.executionId !== active.id || basis.role !== active.role || basis.startedAt !== active.startedAt) return false;
  return basis.kind === "legacy" ? active.ownerId === undefined && active.leaseExpiresAt === undefined
    : basis.ownerId === active.ownerId && basis.leaseExpiresAt === active.leaseExpiresAt;
}

function assertLeaseBasis(id: TaskId, basis: ExecutionLeaseBasis, active: ActiveExecution | undefined): void {
  if (basisMatches(basis, active)) return;
  if (active) throw new ProviderClaimConflict(id, active);
  throw new Error(`Execution lease basis no longer exists for task ${id}`);
}

function assertLeaseGuard(id: TaskId, active: ActiveExecution, guard: ExecutionLeaseGuard): void {
  if (!guard.ownerId.trim() || !isCanonicalTimestamp(guard.observedAt) || !isCanonicalTimestamp(guard.leaseExpiresAt)
    || active.ownerId !== guard.ownerId || active.leaseExpiresAt !== guard.leaseExpiresAt
    || Date.parse(guard.leaseExpiresAt) <= Date.parse(guard.observedAt)) throw new ProviderClaimConflict(id, active);
}

function sameTerminal(event: ProviderEvent, completion: ExecutionCompletion): boolean {
  return event.record !== undefined && isDeepStrictEqual(event.record, completion.record)
    && isDeepStrictEqual(event.comments ?? [], completion.comments) && isDeepStrictEqual(event.artifacts ?? [], completion.artifacts);
}

function validateWorkItem(value: unknown): AzureWorkItem {
  if (!value || typeof value !== "object") throw new Error("Invalid Azure DevOps work item");
  const item = value as AzureWorkItem;
  positiveInteger(requiredNumber(item.id, "work item id"), "work item id");
  positiveInteger(requiredNumber(item.rev, "work item revision"), "work item revision");
  if (!item.fields || typeof item.fields !== "object") throw new Error("Invalid Azure DevOps work item fields");
  if (item.relations !== undefined && !Array.isArray(item.relations)) throw new Error("Invalid Azure DevOps work item relations");
  return item;
}

function validateComment(value: unknown): AzureComment {
  if (!value || typeof value !== "object") throw new Error("Invalid Azure DevOps comment");
  const comment = value as AzureComment;
  commentId(comment);
  requiredString(comment.text, "comment text");
  canonicalTimestamp(comment.createdDate, "comment created date");
  return comment;
}

function normalizeComment(comment: AzureComment): TaskComment {
  return Object.freeze({ id: String(commentId(comment)), body: stripToolMarker(requiredString(comment.text, "comment text")),
    ...(identityName(comment.createdBy) ? { author: identityName(comment.createdBy)! } : {}),
    createdAt: canonicalTimestamp(comment.createdDate, "comment created date") });
}

function blockerReferences(item: AzureWorkItem, relation: string): readonly { readonly id: number }[] {
  return Object.freeze((item.relations ?? []).filter((entry) => entry.rel === relation).map((entry) => {
    const match = /\/workItems\/(\d+)(?:\?.*)?$/iu.exec(requiredString(entry.url, "blocker URL"));
    if (!match) throw new Error("Invalid Azure DevOps blocker URL");
    return Object.freeze({ id: positiveInteger(Number(match[1]), "blocker id") });
  }).sort((left, right) => left.id - right.id));
}

function portableStatus(value: string, states: AzureDevOpsNativeStates): string {
  if (value === states.completed) return "completed";
  if (value === states.blocked) return "blocked";
  if (value === states.failed) return "failed";
  if (value === states.running) return "running";
  if (value === states.ready) return "ready";
  return "unmanaged";
}

function nativeState(value: string, states: AzureDevOpsNativeStates): string {
  const state = states[value as keyof AzureDevOpsNativeStates];
  if (!state) throw new Error(`Unsupported Azure DevOps portable status: ${value}`);
  return state;
}

function tagsFrom(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") throw new Error("Invalid Azure DevOps work item tags");
  return [...new Set(value.split(";").map((tag) => tag.trim()).filter(Boolean))].sort();
}

function identityName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value !== "object") throw new Error("Invalid Azure DevOps identity");
  const identity = value as AzureIdentity;
  return identity.uniqueName ?? identity.displayName ?? identity.id;
}

function acceptanceCriteria(value: unknown): readonly string[] {
  const text = plainText(value);
  return text ? text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
}

function plainText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("Invalid Azure DevOps rich text field");
  return value.replace(/<br\s*\/?\s*>/giu, "\n").replace(/<\/p\s*>/giu, "\n").replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").trim();
}

function compareTasks(left: Task, right: Task): number {
  if (left.priority !== undefined || right.priority !== undefined) {
    if (left.priority === undefined) return 1;
    if (right.priority === undefined) return -1;
    if (left.priority !== right.priority) return left.priority - right.priority;
  }
  return compareTaskIds(left.id, right.id);
}

function compareTaskIds(left: string, right: string): number { return taskNumber(left) - taskNumber(right); }
function compareComments(left: TaskComment, right: TaskComment): number { return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id); }
function compareRecords(left: ExecutionRecord, right: ExecutionRecord): number { return left.finishedAt.localeCompare(right.finishedAt) || left.id.localeCompare(right.id); }
function isTerminal(kind: ProviderEvent["kind"]): boolean { return kind === "complete" || kind === "fail" || kind === "cancel" || kind === "block"; }
function isRevisionConflict(error: unknown): boolean { return error instanceof AzureDevOpsApiError && [400, 409, 412].includes(error.status); }
function jsonPointer(value: string): string { return value.replace(/~/gu, "~0").replace(/\//gu, "~1"); }
function taskNumber(id: TaskId): number { if (!/^\d+$/u.test(id)) throw new Error(`Invalid Azure DevOps work item ID: ${id}`); return positiveInteger(Number(id), "work item id"); }
function fieldName(value: string, name: string): string { if (!/^[A-Za-z][A-Za-z0-9_.-]+$/u.test(value)) throw new Error(`Invalid Azure DevOps ${name}`); return value; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`Invalid Azure DevOps ${name}`); return value; }
function requiredNumber(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid Azure DevOps ${name}`); return value; }
function positiveInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); return value; }
function optionalFiniteNumber(value: unknown): number | undefined { if (value === undefined || value === null || value === "") return undefined; if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid Azure DevOps priority"); return value; }
function isCanonicalTimestamp(value: unknown): value is string { if (typeof value !== "string") return false; const epoch = Date.parse(value); return Number.isFinite(epoch) && new Date(epoch).toISOString() === value; }
function canonicalTimestamp(value: unknown, name: string): string { const text = requiredString(value, name); const epoch = Date.parse(text); if (!Number.isFinite(epoch)) throw new Error(`Invalid Azure DevOps ${name}`); return new Date(epoch).toISOString(); }
function commentId(comment: AzureComment): number { return positiveInteger(requiredNumber(comment.commentId ?? comment.id, "comment id"), "comment id"); }
function safeError(error: unknown): string { return error instanceof AzureDevOpsApiError ? `Azure DevOps read failed (${error.status})` : "Azure DevOps read failed"; }
function assertDistinctStates(states: AzureDevOpsNativeStates): void { if (Object.values(states).some((state) => !state.trim()) || new Set(Object.values(states)).size !== 5) throw new Error("Azure DevOps native states must be non-empty and distinct"); }
function freezeRecord(record: ExecutionRecord): ExecutionRecord { return Object.freeze({ ...record, failure: record.failure && Object.freeze({ ...record.failure }), blockingRequest: record.blockingRequest && Object.freeze({ ...record.blockingRequest }) }); }

function diagnosticExecution(state: ProviderExecutionState): ProviderTaskDiagnostic["execution"] {
  return Object.freeze({ ...(state.active ? { active: state.active } : {}), history: Object.freeze(state.history.slice(-100).map((record) => Object.freeze({
    id: boundedText(record.id, 256), role: boundedText(record.role, 256), outcome: boundedText(record.outcome, 256), finishedAt: record.finishedAt,
    ...(record.nextRole ? { nextRole: boundedText(record.nextRole, 256) } : {}), ...(record.failure ? { failure: record.failure } : {}),
  }))), ...(state.nextRole ? { nextRole: boundedText(state.nextRole, 256) } : {}) });
}

function diagnosticJournal(events: readonly ProviderEvent[]): readonly ProviderJournalDiagnostic[] {
  const selected = events.slice(-1_000);
  const offset = events.length - selected.length;
  return Object.freeze(selected.map((event, index) => Object.freeze({ sequence: offset + index + 1, kind: event.kind,
    executionId: boundedText(event.executionId, 256), createdAt: event.createdAt, ...(event.role ? { role: boundedText(event.role, 256) } : {}),
    ...(event.ownerId ? { ownerId: boundedText(event.ownerId, 256) } : {}), ...(event.leaseExpiresAt ? { leaseExpiresAt: event.leaseExpiresAt } : {}),
    ...(event.record?.outcome ? { outcome: boundedText(event.record.outcome, 256) } : {}) })));
}

function boundedTask(task: Task): PortableJsonValue {
  return Object.freeze({ id: task.id, title: boundedText(task.title, TOOL_TEXT_LIMIT), description: boundedText(task.description, TOOL_TEXT_LIMIT),
    status: task.status, acceptanceCriteria: Object.freeze(task.acceptanceCriteria.slice(0, TOOL_ITEM_LIMIT).map((item) => boundedText(item, TOOL_TEXT_LIMIT))),
    labels: Object.freeze(task.labels.slice(0, TOOL_ITEM_LIMIT)), assignees: Object.freeze(task.assignees.slice(0, TOOL_ITEM_LIMIT)),
    blockers: Object.freeze((task.blockers ?? []).slice(0, TOOL_ITEM_LIMIT).map((item) => Object.freeze({ id: item.id, resolved: item.resolved,
      ...(item.status ? { status: item.status } : {}) }))) });
}
function boundedComment(comment: TaskComment): PortableJsonValue { return Object.freeze({ id: comment.id, body: boundedText(comment.body, TOOL_TEXT_LIMIT), createdAt: comment.createdAt, ...(comment.author ? { author: boundedText(comment.author, 256) } : {}) }); }
function boundedArtifact(artifact: Artifact): PortableJsonValue { return Object.freeze({ type: boundedText(artifact.type, 256), url: boundedText(artifact.url, 4_096), ...(artifact.name ? { name: boundedText(artifact.name, 1_024) } : {}) }); }
function boundedCollection<T>(values: readonly T[], map: (value: T) => PortableJsonValue): readonly PortableJsonValue[] { const result: PortableJsonValue[] = []; for (const value of values) { const candidate = map(value); if (Buffer.byteLength(JSON.stringify([...result, candidate]), "utf8") > TOOL_RESULT_BUDGET) break; result.push(candidate); } return Object.freeze(result); }
function boundedText(value: string, maximumBytes: number): string { const bytes = Buffer.from(value, "utf8"); if (bytes.length <= maximumBytes) return value; let end = maximumBytes; while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1; return bytes.subarray(0, end).toString("utf8"); }
function toolCommentInput(input: unknown): { readonly body: string; readonly idempotencyKey: string } { if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid comment tool input"); const value = input as Record<string, unknown>; if (typeof value.body !== "string" || !value.body.trim() || Buffer.byteLength(value.body, "utf8") > TOOL_TEXT_LIMIT || typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.idempotencyKey)) throw new Error("Invalid comment tool input"); return { body: value.body, idempotencyKey: value.idempotencyKey }; }
function toolMarker(executionId: string, key: string): string { return `${TOOL_MARKER}${Buffer.from(executionId).toString("base64url")}:${Buffer.from(key).toString("base64url")} -->`; }
function effectMarker(executionId: string, index: number): string { return `${EFFECT_MARKER}${Buffer.from(executionId).toString("base64url")}:${index} -->`; }
function stripToolMarker(body: string): string { return body.startsWith(TOOL_MARKER) || body.startsWith(EFFECT_MARKER) ? body.slice(body.indexOf("\n") + 1) : body; }
