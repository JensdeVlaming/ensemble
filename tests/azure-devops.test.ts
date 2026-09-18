import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionCompletion, ExecutionLeaseClaim, RepositoryRef } from "../src/index.ts";
import { ProviderClaimConflict } from "../src/providers/provider.ts";
import { AzureDevOpsApiError, AzureDevOpsClient } from "../src/providers/azure-devops/client.ts";
import { AzureDevOpsProvider } from "../src/providers/azure-devops/adapter.ts";
import type { AzureDevOpsProviderOptions } from "../src/providers/azure-devops/adapter.ts";

const repository: RepositoryRef = { id: "ensemble", url: "https://example.test/ensemble.git", defaultBranch: "main" };
const states = { ready: "New", running: "Active", blocked: "Blocked", failed: "Failed", completed: "Closed" };

test("Azure DevOps client uses PAT Basic auth, API 7.1, bounded read retries, and redacted errors", async () => {
  const events: string[] = [];
  const delays: number[] = [];
  let calls = 0;
  const client = new AzureDevOpsClient({
    organization: "example", project: "Ensemble", pat: "never-log-this", maxRetries: 1,
    delay: async (milliseconds) => { delays.push(milliseconds); }, onEvent: (event) => { events.push(event.kind); },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/example/Ensemble/_apis/wit/workitems/1");
      assert.equal(url.searchParams.get("api-version"), "7.1");
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from(":never-log-this").toString("base64")}`);
      calls += 1;
      return calls === 1 ? response({ message: "busy" }, 429, { "x-ms-retry-after-ms": "120000" }) : response({ id: 1 });
    },
  });
  assert.deepEqual(await client.request("GET", "_apis/wit/workitems/1"), { id: 1 });
  assert.deepEqual(delays, [30_000]);
  assert.deepEqual(events, ["rate_limit", "request_retry"]);

  const failing = new AzureDevOpsClient({
    organization: "example", project: "Ensemble", pat: "never-log-this", maxRetries: 0,
    fetch: async () => response({ message: `forbidden ${"x".repeat(1_000)}`, typeKey: "Denied" }, 403),
  });
  await assert.rejects(failing.request("GET", "_apis/wit/workitems/1?token=also-secret"), (error: unknown) => {
    assert.ok(error instanceof AzureDevOpsApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "Denied");
    assert.doesNotMatch(error.message, /never-log-this|also-secret/u);
    assert.ok(error.message.length < 700);
    return true;
  });
});

test("Azure DevOps client follows continuation tokens and sends deterministic batches of at most 200", async () => {
  const batches: number[][] = [];
  const client = new AzureDevOpsClient({
    organization: "example", project: "Ensemble", pat: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/comments")) {
        const token = url.searchParams.get("continuationToken");
        return token ? response({ comments: [{ id: 2 }] }) : response({ comments: [{ id: 1 }] }, 200, { "x-ms-continuationtoken": "next" });
      }
      assert.ok(url.pathname.endsWith("/workitemsbatch"));
      const body = parseBody(init);
      const ids = body.ids as number[];
      assert.equal(body.errorPolicy, "Omit");
      batches.push(ids);
      return response({ count: ids.length, value: ids.map((id) => ({ id })) });
    },
  });
  const comments = await client.continuation<{ id: number }>("_apis/wit/workitems/1/comments", (payload) => {
    const body = payload as { comments: Array<{ id: number }> };
    return { items: body.comments };
  }, { maxPages: 2, maxItems: 2 });
  assert.deepEqual(comments, [{ id: 1 }, { id: 2 }]);

  const ids = Array.from({ length: 205 }, (_, index) => 205 - index);
  assert.equal((await client.workItemsBatch(ids, ["System.Id"])).length, 205);
  assert.deepEqual(batches.map((batch) => batch.length), [200, 5]);
  assert.deepEqual(batches[0]?.slice(0, 3), [1, 2, 3]);

  const invalid = new AzureDevOpsClient({
    organization: "example", project: "Ensemble", pat: "test",
    fetch: async () => response([{ id: 1 }]),
  });
  await assert.rejects(invalid.workItemsBatch([1], ["System.Id"]), /batch response is invalid/u);
});

test("Azure DevOps client requires revision-tested JSON Patch and never retries writes", async () => {
  let calls = 0;
  const client = new AzureDevOpsClient({
    organization: "example", project: "Ensemble", pat: "test", maxRetries: 3,
    fetch: async (_input, init) => { calls += 1; assert.equal(new Headers(init?.headers).get("content-type"), "application/json-patch+json"); return response({ message: "conflict" }, 412); },
  });
  await assert.rejects(client.patch("_apis/wit/workitems/1", [{ op: "add", path: "/fields/System.State", value: "Active" }]), /revision test/u);
  assert.equal(calls, 0);
  await assert.rejects(client.patch("_apis/wit/workitems/1", [{ op: "test", path: "/rev", value: 1 }]), AzureDevOpsApiError);
  assert.equal(calls, 1);
});

test("Azure DevOps client retries work-item batch POSTs only through the safe read path", async () => {
  let calls = 0;
  const client = new AzureDevOpsClient({
    organization: "example", project: "Ensemble", pat: "test", maxRetries: 1, delay: async () => undefined,
    fetch: async () => { calls += 1; return calls === 1 ? response({ message: "busy" }, 503) : response({ count: 1, value: [{ id: 1 }] }); },
  });
  assert.deepEqual(await client.workItemsBatch<{ id: number }>([1], ["System.Id"]), [{ id: 1 }]);
  assert.equal(calls, 2);
});

test("Azure DevOps adapter validates configuration and normalizes saved-query work items", async () => {
  const api = new FakeAzureDevOpsApi([
    workItem(2, "Blocked", "New", "ensemble; backend", "bot@example.test", 2, [{ rel: "System.LinkTypes.Dependency-Reverse", url: "https://dev.azure.com/example/Ensemble/_apis/wit/workItems/99" }]),
    workItem(1, "Ready", "New", "backend; ensemble", "bot@example.test", 1),
    workItem(99, "Dependency", "Active", "", undefined, 9),
  ], [2, 1]);
  const provider = providerFor(api, "execution-1", { requiredTags: ["ensemble"], requiredAssignee: "bot@example.test" });
  await provider.validateConfiguration();
  const inventory = await provider.inventoryTasks();
  assert.equal(inventory.completeness, "complete");
  assert.deepEqual(inventory.entries.map((entry) => entry.task.id), ["1", "2"]);
  const candidates = await provider.discoverTasks({ scope: "workflow_candidates" });
  assert.deepEqual(candidates.map((task) => task.id), ["1"]);
  assert.equal(candidates[0]?.priority, 1);
  assert.equal(candidates[0]?.description, "Build it");
  assert.deepEqual(candidates[0]?.acceptanceCriteria, ["Works", "Tested"]);
  const blocked = await provider.getTask("2");
  assert.equal(blocked.dispatchable, false);
  assert.deepEqual(blocked.blockers, [{ id: "99", status: "running", resolved: false }]);
  assert.deepEqual(provider.repository, repository);
});

test("Azure DevOps discovery recovers active local state outside the saved query and inventory reconciles all local state", async () => {
  const api = new FakeAzureDevOpsApi([
    workItem(1, "Saved", "New", "", undefined, 1),
    workItem(2, "Active local", "New", "", undefined, 2),
    workItem(3, "Active foreign", "New", "", undefined, 3),
    workItem(4, "Terminal local", "New", "", undefined, 4),
  ], [1]);
  const provider = providerFor(api, "local-active");
  await provider.beginExecution("2", "implementation", "running", claim(undefined, "local-worker"));
  const foreignRepository = { ...repository, id: "other-registration" };
  await providerFor(api, "foreign-active", { repository: foreignRepository })
    .beginExecution("3", "implementation", "running", claim(undefined, "foreign-worker"));
  const terminal = await providerFor(api, "local-terminal").beginExecution("4", "implementation", "running", claim(undefined, "terminal-worker"));
  await provider.completeExecution("4", terminal.id, guard(terminal), {
    record: { id: terminal.id, role: terminal.role, outcome: "approved", summary: "Done", finishedAt: "2026-09-18T11:00:00.000Z" },
    comments: [], artifacts: [], status: "completed",
  });

  const candidates = await provider.discoverTasks({ scope: "workflow_candidates" });
  assert.deepEqual(candidates.map((task) => task.id), ["1", "2"]);
  const inventory = await provider.inventoryTasks();
  assert.equal(inventory.completeness, "complete");
  assert.deepEqual(inventory.entries.map((entry) => [entry.task.id, entry.lifecycle]), [
    ["1", "current"], ["2", "current"], ["4", "terminal"],
  ]);
  assert.match(String(api.items.get(2)?.fields["Custom.EnsembleState"]), /"repositoryId":"ensemble"/u);
  await assert.rejects(provider.getExecutionState("3"), /belongs to another repository: other-registration/u);
  assert.ok(api.stateQueries.every((query) => query === "SELECT [System.Id] FROM WorkItems WHERE [Custom.EnsembleState] IS NOT EMPTY"));
});

test("Azure DevOps state validation rejects unscoped state while state discovery isolates other registrations", async () => {
  const api = new FakeAzureDevOpsApi([
    workItem(1, "Foreign", "Active", "", undefined, 1),
    workItem(2, "Unscoped", "Active", "", undefined, 2),
  ], []);
  api.items.get(1)!.fields["Custom.EnsembleState"] = providerState("other-registration", [{ malformed: true }]);
  const provider = providerFor(api, "unused");
  await assert.rejects(provider.getExecutionState("1"), /belongs to another repository/u);
  assert.deepEqual((await provider.inventoryTasks()).entries, []);

  api.items.get(2)!.fields["Custom.EnsembleState"] = JSON.stringify({ protocol: "ensemble-azure-devops-state/v1", events: [] });
  await assert.rejects(provider.getExecutionState("2"), /Invalid Azure DevOps provider state field/u);
  await assert.rejects(provider.inventoryTasks(), /Invalid Azure DevOps provider state field/u);
});

test("Azure DevOps query execution enforces flat bounded results and reports incomplete batch retrieval", async () => {
  const shaped = new FakeAzureDevOpsApi([workItem(1, "One", "New", "", undefined, 1)], [1]);
  shaped.savedQueryPayload = { queryType: "tree", workItemRelations: [] };
  await assert.rejects(providerFor(shaped, "unused").inventoryTasks(), /saved query response has no flat work item list/u);

  const bounded = new FakeAzureDevOpsApi([
    workItem(1, "One", "New", "", undefined, 1), workItem(2, "Two", "New", "", undefined, 2),
  ], [1, 2]);
  await assert.rejects(providerFor(bounded, "unused", { inventoryMaxItems: 1 }).inventoryTasks(), /saved query item limit exceeded/u);
  assert.ok(bounded.queryTops.every((top) => top === "2"));

  const union = new FakeAzureDevOpsApi([
    workItem(1, "Saved", "New", "", undefined, 1), workItem(2, "State", "Active", "", undefined, 2),
  ], [1]);
  union.items.get(2)!.fields["Custom.EnsembleState"] = providerState(repository.id, []);
  await assert.rejects(providerFor(union, "unused", { inventoryMaxItems: 1 }).inventoryTasks(), /managed item limit exceeded/u);

  const incomplete = new FakeAzureDevOpsApi([
    workItem(1, "One", "New", "", undefined, 1), workItem(2, "Two", "New", "", undefined, 2),
  ], [1, 2]);
  incomplete.omitBatchIds.add(2);
  const inventory = await providerFor(incomplete, "unused").inventoryTasks();
  assert.equal(inventory.completeness, "partial");
  assert.deepEqual(inventory.entries.map((entry) => entry.task.id), ["1"]);
});

test("Azure DevOps refresh is deterministic and distinguishes missing from unreadable", async () => {
  const api = new FakeAzureDevOpsApi([workItem(1, "One", "New", "", undefined, 1)], [1]);
  const provider = providerFor(api, "unused");
  const refreshed = await provider.refreshTasks(["3", "1", "2"]);
  assert.deepEqual([...refreshed.keys()], ["1", "2", "3"]);
  assert.equal(refreshed.get("1")?.kind, "current");
  assert.equal(refreshed.get("2")?.kind, "missing");
  api.failBatch = true;
  const unreadable = await provider.refreshTasks(["1"]);
  assert.deepEqual(unreadable.get("1"), { kind: "unreadable", error: "Azure DevOps read failed (500)" });
});

test("Azure DevOps refresh recovers a readable work item omitted by the batch API", async () => {
  const api = new FakeAzureDevOpsApi([
    workItem(1, "One", "New", "", undefined, 1),
    workItem(2, "Two", "New", "", undefined, 2),
  ], [1, 2]);
  api.omitBatchIds.add(2);

  const refreshed = await providerFor(api, "unused").refreshTasks(["2", "1"]);

  assert.deepEqual([...refreshed.keys()], ["1", "2"]);
  assert.equal(refreshed.get("1")?.kind, "current");
  assert.equal(refreshed.get("2")?.kind, "current");
  assert.deepEqual(api.itemReads, [2]);
});

test("Azure DevOps refresh classifies an omitted work item as missing only after an individual 404", async () => {
  const api = new FakeAzureDevOpsApi([], []);

  const refreshed = await providerFor(api, "unused").refreshTasks(["42"]);

  assert.deepEqual(refreshed.get("42"), { kind: "missing" });
  assert.deepEqual(api.itemReads, [42]);
});

test("Azure DevOps refresh keeps an omitted work item unreadable after an individual transient error", async () => {
  const api = new FakeAzureDevOpsApi([workItem(7, "Seven", "New", "", undefined, 7)], [7]);
  api.omitBatchIds.add(7);
  api.itemReadFailures.set(7, 503);

  const refreshed = await providerFor(api, "unused").refreshTasks(["7"]);

  assert.deepEqual(refreshed.get("7"), { kind: "unreadable", error: "Azure DevOps read failed (503)" });
  assert.deepEqual(api.itemReads, [7]);
});

test("Azure DevOps revision-guarded claims have one winner and preserve takeover identity", async () => {
  const api = new FakeAzureDevOpsApi([workItem(1, "Race", "New", "", undefined, 1)], [1]);
  api.patchGate = deferred();
  const left = providerFor(api, "left");
  const right = providerFor(api, "right");
  const pending = Promise.allSettled([
    left.beginExecution("1", "implementation", "running", claim(undefined, "worker-left")),
    right.beginExecution("1", "implementation", "running", claim(undefined, "worker-right")),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.patchGate.resolve();
  const settled = await pending;
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  assert.ok(rejected?.reason instanceof ProviderClaimConflict);
  const active = (await left.getExecutionState("1")).active!;
  assert.ok(active.id === "left" || active.id === "right");

  const takeover = await providerFor(api, "ignored").beginExecution("1", "ignored", "running", {
    ownerId: "new-owner", observedAt: "2100-01-01T00:00:00.000Z", expiresAt: "2100-01-01T00:01:00.000Z",
    expected: { kind: "leased", executionId: active.id, role: active.role, startedAt: active.startedAt,
      ownerId: active.ownerId!, leaseExpiresAt: active.leaseExpiresAt! },
  });
  assert.equal(takeover.id, active.id);
  assert.equal(takeover.startedAt, active.startedAt);
  assert.equal(takeover.ownerId, "new-owner");
});

test("Azure DevOps terminal synchronization is durable, restart-safe, and idempotent", async () => {
  const api = new FakeAzureDevOpsApi([workItem(1, "Work", "New", "ensemble", "bot@example.test", 1)], [1]);
  const provider = providerFor(api, "execution-1");
  const active = await provider.beginExecution("1", "implementation", "running", claim(undefined, "worker-1"));
  const completion: ExecutionCompletion = {
    record: { id: active.id, role: active.role, outcome: "approved", summary: "Done", finishedAt: "2026-09-18T11:00:00.000Z" },
    comments: ["Validation passed"], artifacts: [{ type: "pull_request", url: "https://example.test/pr/1" }], status: "completed",
  };
  api.failNextComment = true;
  await assert.rejects(provider.completeExecution("1", active.id, guard(active), completion), AzureDevOpsApiError);
  assert.equal((await provider.getExecutionState("1")).history.length, 1);

  const restarted = providerFor(api, "unused");
  await restarted.completeExecution("1", active.id, guard(active), completion);
  await restarted.completeExecution("1", active.id, guard(active), completion);
  assert.equal(api.items.get(1)?.fields["System.State"], "Closed");
  assert.deepEqual((await restarted.getExecutionState("1")).history.map((record) => record.id), ["execution-1"]);
  assert.deepEqual((await restarted.getComments("1")).map((comment) => comment.body), ["Validation passed"]);
  assert.deepEqual(await restarted.getArtifacts("1"), completion.artifacts);
  assert.equal(api.comments.get(1)?.length, 1);
});

test("Azure DevOps lease renewal state stays bounded and reconstructs active and terminal state", async () => {
  const api = new FakeAzureDevOpsApi([workItem(1, "Work", "New", "", undefined, 1)], [1]);
  const executionIds = ["execution-history", "execution-active"];
  const provider = providerFor(api, "unused", { executionId: () => executionIds.shift()! });
  const historical = await provider.beginExecution("1", "implementation", "running", {
    ownerId: "worker-history", observedAt: "2026-09-18T10:00:00.000Z", expiresAt: "2026-09-18T10:05:00.000Z",
    expected: { kind: "none" },
  });
  const completion: ExecutionCompletion = {
    record: { id: historical.id, role: historical.role, outcome: "approved", summary: "Done", finishedAt: "2026-09-18T10:01:00.000Z" },
    comments: [], artifacts: [], status: "completed",
  };
  await provider.completeExecution("1", historical.id, {
    ownerId: historical.ownerId!, leaseExpiresAt: historical.leaseExpiresAt!, observedAt: "2026-09-18T10:01:00.000Z",
  }, completion);
  let active = await provider.beginExecution("1", "verification", "running", {
    ownerId: "worker-active", observedAt: "2026-09-18T10:02:00.000Z", expiresAt: "2026-09-18T10:03:00.000Z",
    expected: { kind: "none" },
  });
  let firstRenewalSize = 0;
  let expectedExpiry = active.leaseExpiresAt!;
  for (let index = 0; index < 500; index += 1) {
    const previousExpiry = Date.parse(active.leaseExpiresAt!);
    expectedExpiry = new Date(previousExpiry + 60_000).toISOString();
    active = await provider.renewExecutionLease("1", active.id, {
      ownerId: active.ownerId!,
      observedAt: new Date(previousExpiry - 30_000).toISOString(),
      expiresAt: expectedExpiry,
      expected: { kind: "leased", executionId: active.id, role: active.role, startedAt: active.startedAt,
        ownerId: active.ownerId!, leaseExpiresAt: active.leaseExpiresAt! },
    });
    if (index === 0) firstRenewalSize = String(api.items.get(1)?.fields["Custom.EnsembleState"]).length;
  }

  const serialized = String(api.items.get(1)?.fields["Custom.EnsembleState"]);
  assert.equal(serialized.length, firstRenewalSize);
  assert.equal((JSON.parse(serialized) as { events: unknown[] }).events.length, 4);
  assert.equal(active.leaseExpiresAt, expectedExpiry);
  assert.equal(active.leaseExpiresAt, "2026-09-18T18:23:00.000Z");
  const restarted = providerFor(api, "unused");
  const reconstructed = await restarted.getExecutionState("1");
  assert.deepEqual(reconstructed.history.map((record) => record.id), ["execution-history"]);
  assert.deepEqual(reconstructed.active, active);
  await restarted.completeExecution("1", historical.id, {
    ownerId: historical.ownerId!, leaseExpiresAt: historical.leaseExpiresAt!, observedAt: "2026-09-18T10:01:00.000Z",
  }, completion);
  assert.deepEqual((await restarted.getExecutionState("1")).active, active);
  const takeoverObservedAt = active.leaseExpiresAt!;
  const takeover = await restarted.beginExecution("1", "ignored", "running", {
    ownerId: "worker-takeover", observedAt: takeoverObservedAt,
    expiresAt: new Date(Date.parse(takeoverObservedAt) + 60_000).toISOString(),
    expected: { kind: "leased", executionId: active.id, role: active.role, startedAt: active.startedAt,
      ownerId: active.ownerId!, leaseExpiresAt: active.leaseExpiresAt! },
  });
  assert.equal(takeover.id, active.id);
  assert.equal(takeover.startedAt, active.startedAt);
  assert.equal(takeover.ownerId, "worker-takeover");
  assert.deepEqual((await restarted.getExecutionState("1")).history.map((record) => record.id), ["execution-history"]);
});

test("Azure DevOps rejects malformed durable state and redacts runtime tool failures", async () => {
  const api = new FakeAzureDevOpsApi([workItem(1, "Malformed", "New", "", undefined, 1)], [1]);
  api.items.get(1)!.fields["Custom.EnsembleState"] = "{broken";
  const provider = providerFor(api, "execution");
  await assert.rejects(provider.getExecutionState("1"), /Malformed Azure DevOps provider state/u);

  delete api.items.get(1)!.fields["Custom.EnsembleState"];
  const active = await provider.beginExecution("1", "implementation", "running", claim(undefined, "worker"));
  const tools = await provider.getRuntimeTools("1", active.id, active.ownerId!);
  api.failReads = true;
  await assert.rejects(tools.find((tool) => tool.name === "task_read")!.invoke({}), (error: unknown) => {
    assert.equal((error as Error).message, "Azure DevOps tool task_read failed");
    assert.doesNotMatch(String(error), /test-pat|upstream-secret/u);
    return true;
  });
});

function providerFor(api: FakeAzureDevOpsApi, executionId: string, extra: Partial<AzureDevOpsProviderOptions> = {}): AzureDevOpsProvider {
  return new AzureDevOpsProvider({
    organization: "example", project: "Ensemble", pat: "test-pat", queryId: "query-1",
    stateField: "Custom.EnsembleState", repository, nativeStates: states, priorityField: "Microsoft.VSTS.Common.Priority",
    fetch: api.fetch, maxRetries: 0, executionId: () => executionId, now: () => new Date("2026-09-18T10:00:00.000Z"), ...extra,
  });
}

function claim(active: Awaited<ReturnType<AzureDevOpsProvider["beginExecution"]>> | undefined, ownerId: string): ExecutionLeaseClaim {
  return { ownerId, observedAt: "2026-09-18T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    expected: active ? { kind: "leased", executionId: active.id, role: active.role, startedAt: active.startedAt,
      ownerId: active.ownerId!, leaseExpiresAt: active.leaseExpiresAt! } : { kind: "none" } };
}

function guard(active: Awaited<ReturnType<AzureDevOpsProvider["beginExecution"]>>) {
  return { ownerId: active.ownerId!, leaseExpiresAt: active.leaseExpiresAt!, observedAt: "2026-09-18T10:30:00.000Z" };
}

function workItem(
  id: number,
  title: string,
  state: string,
  tags: string,
  assignee: string | undefined,
  priority: number,
  relations: readonly unknown[] = [],
): { id: number; rev: number; fields: Record<string, unknown>; relations: readonly unknown[] } {
  return { id, rev: 1, fields: { "System.Id": id, "System.Title": title, "System.Description": "<p>Build it</p>",
    "System.State": state, "System.Tags": tags, ...(assignee ? { "System.AssignedTo": { uniqueName: assignee, displayName: assignee } } : {}),
    "Microsoft.VSTS.Common.Priority": priority, "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>Works<br>Tested</p>" }, relations };
}

class FakeAzureDevOpsApi {
  readonly items = new Map<number, ReturnType<typeof workItem>>();
  readonly comments = new Map<number, Array<Record<string, unknown>>>();
  readonly queryIds: number[];
  readonly stateQueries: string[] = [];
  readonly queryTops: string[] = [];
  readonly omitBatchIds = new Set<number>();
  readonly itemReads: number[] = [];
  readonly itemReadFailures = new Map<number, number>();
  savedQueryPayload?: unknown;
  stateQueryPayload?: unknown;
  failBatch = false;
  failReads = false;
  failNextComment = false;
  patchGate?: ReturnType<typeof deferred>;
  #commentId = 0;

  constructor(items: readonly ReturnType<typeof workItem>[], queryIds: number[]) {
    for (const item of items) this.items.set(item.id, structuredClone(item));
    this.queryIds = queryIds;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/example/Ensemble/", "");
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from(":test-pat").toString("base64")}`);
    if (this.failReads && method === "GET") return response({ message: "upstream-secret" }, 500);
    if (method === "GET" && path === "_apis/wit/queries/query-1") return response({ id: "query-1", queryType: "flat", wiql: "SELECT [System.Id] FROM WorkItems" });
    if (method === "GET" && path === "_apis/wit/fields/Custom.EnsembleState") return response({ referenceName: "Custom.EnsembleState", type: "plainText" });
    if ((method === "GET" && path === "_apis/wit/wiql/query-1") || (method === "POST" && path === "_apis/wit/wiql")) {
      this.queryTops.push(url.searchParams.get("$top") ?? "");
      if (method === "GET") return response(this.savedQueryPayload ?? { queryType: "flat", workItems: this.queryIds.map((id) => ({ id })) });
      const query = parseBody(init).query;
      assert.equal(typeof query, "string");
      this.stateQueries.push(query as string);
      const stateIds = [...this.items.values()].filter((item) => item.fields["Custom.EnsembleState"] !== undefined
        && item.fields["Custom.EnsembleState"] !== "").map((item) => item.id);
      return response(this.stateQueryPayload ?? { queryType: "flat", workItems: stateIds.map((id) => ({ id })) });
    }
    if (method === "POST" && path === "_apis/wit/workitemsbatch") {
      if (this.failBatch) return response({ message: "broken" }, 500);
      const body = parseBody(init);
      const ids = body.ids as number[];
      assert.ok(ids.length <= 200);
      assert.equal(body.errorPolicy, "Omit");
      const value = ids.flatMap((id) => this.items.has(id) && !this.omitBatchIds.has(id) ? [structuredClone(this.items.get(id)!)] : []);
      return response({ count: value.length, value });
    }
    const itemMatch = /^_apis\/wit\/workitems\/(\d+)$/u.exec(path);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      if (method === "GET") {
        this.itemReads.push(id);
        const failure = this.itemReadFailures.get(id);
        if (failure !== undefined) return response({ message: "temporary failure" }, failure);
      }
      const item = this.items.get(id);
      if (!item) return response({ message: "not found" }, 404);
      if (method === "GET") return response(structuredClone(item));
      if (method === "PATCH") {
        await this.patchGate?.promise;
        const operations = parseBodyArray(init);
        assert.deepEqual(operations[0], { op: "test", path: "/rev", value: operations[0]?.value });
        if (operations[0]?.value !== item.rev) return response({ message: "revision conflict" }, 412);
        for (const operation of operations.slice(1)) {
          if (operation.path === "/fields/System.State") item.fields["System.State"] = String(operation.value);
          else if (operation.path === "/fields/Custom.EnsembleState") item.fields["Custom.EnsembleState"] = String(operation.value);
          else if (operation.path === "/fields/System.History") item.fields["System.History"] = String(operation.value);
        }
        item.rev += 1;
        return response(structuredClone(item));
      }
    }
    const commentsMatch = /^_apis\/wit\/workitems\/(\d+)\/comments$/u.exec(path);
    if (commentsMatch) {
      assert.equal(url.searchParams.get("api-version"), "7.1-preview.4");
      const id = Number(commentsMatch[1]);
      if (method === "GET") return response({ comments: structuredClone(this.comments.get(id) ?? []) });
      if (method === "POST") {
        if (this.failNextComment) { this.failNextComment = false; return response({ message: "comment failed" }, 500); }
        this.#commentId += 1;
        const comment = { id: this.#commentId, text: parseBody(init).text, createdDate: "2026-09-18T11:00:00Z",
          createdBy: { uniqueName: "bot@example.test" } };
        const comments = this.comments.get(id) ?? [];
        comments.push(comment);
        this.comments.set(id, comments);
        return response(comment, 201);
      }
    }
    const commentMatch = /^_apis\/wit\/workitems\/(\d+)\/comments\/(\d+)$/u.exec(path);
    if (commentMatch && method === "DELETE") {
      assert.equal(url.searchParams.get("api-version"), "7.1-preview.4");
      const workItemId = Number(commentMatch[1]);
      const commentId = Number(commentMatch[2]);
      const comments = this.comments.get(workItemId) ?? [];
      const index = comments.findIndex((comment) => comment.id === commentId);
      if (index < 0) return response({ message: "not found" }, 404);
      comments.splice(index, 1);
      return response(undefined, 204);
    }
    return response({ message: `unhandled ${method} ${path}` }, 500);
  };
}

function providerState(repositoryId: string, events: readonly unknown[]): string {
  return JSON.stringify({ protocol: "ensemble-azure-devops-state/v1", repositoryId, events });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
}

function parseBodyArray(init: RequestInit | undefined): Array<Record<string, unknown>> {
  return typeof init?.body === "string" ? JSON.parse(init.body) as Array<Record<string, unknown>> : [];
}

function response(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
