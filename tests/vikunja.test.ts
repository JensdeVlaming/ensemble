import assert from "node:assert/strict";
import test from "node:test";
import { leaseClaim, leaseGuard } from "./lease-helpers.ts";
import {
  ProviderClaimConflict,
  VikunjaApiError,
  VikunjaClient,
  VikunjaPaginationLimitError,
  VikunjaProvider,
  validateRuntimeTools,
} from "../src/index.ts";
import type { ExecutionCompletion, RepositoryRef, VikunjaClientEvent, VikunjaProviderOptions } from "../src/index.ts";

const repository: RepositoryRef = { id: "ensemble", url: "https://example.test/ensemble.git", defaultBranch: "main" };
const statusLabels = [
  { id: 1, title: "ensemble:ready" },
  { id: 2, title: "ensemble:running" },
  { id: 3, title: "ensemble:blocked" },
  { id: 4, title: "ensemble:failed" },
  { id: 5, title: "ensemble:completed" },
];

test("Vikunja client authenticates, paginates, and retries complete pages", async () => {
  const calls: URL[] = [];
  let firstPageAttempts = 0;
  const delays: number[] = [];
  const client = new VikunjaClient({
    baseUrl: "https://vikunja.example.test",
    token: "test-token",
    perPage: 1,
    maxRetries: 1,
    retryBaseMs: 5,
    delay: async (milliseconds) => { delays.push(milliseconds); },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
      if (url.searchParams.get("page") === "1" && firstPageAttempts++ === 0) {
        return response({ message: "busy", code: 1 }, 503);
      }
      const page = Number(url.searchParams.get("page"));
      return response([{ id: page }], 200, { "x-pagination-total-pages": "2" });
    },
  });
  assert.deepEqual(await client.paginate<{ id: number }>("labels"), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(delays, [5]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.pathname, "/api/v1/labels");
});

test("Vikunja client surfaces bounded API errors without token disclosure", async () => {
  const client = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "never-log-this", maxRetries: 0,
    fetch: async () => response({ message: "forbidden", code: 1001 }, 403),
  });
  await assert.rejects(client.request("GET", "tasks/1"), (error: unknown) => {
    assert.ok(error instanceof VikunjaApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 1001);
    assert.doesNotMatch(error.message, /never-log-this/u);
    return true;
  });
});

test("Vikunja client retries only GET transport/timeouts and emits isolated immutable rate-limit events", async () => {
  const events: VikunjaClientEvent[] = [];
  const delays: number[] = [];
  let calls = 0;
  const client = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "never-log-this", maxRetries: 1, retryBaseMs: 7,
    now: () => new Date("2026-01-01T00:00:00.000Z"), delay: async (delay) => { delays.push(delay); },
    onEvent: (event) => { events.push(event); if (event.kind === "rate_limit") throw new Error("observer failed"); },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? response({ message: "slow down" }, 429, { "retry-after": "Thu, 01 Jan 2026 00:00:02 GMT" })
        : response({ ok: true });
    },
  });
  assert.deepEqual(await client.request("GET", "tasks/1"), { ok: true });
  assert.deepEqual(delays, [2_000]);
  assert.deepEqual(events.map((event) => event.kind), ["rate_limit", "request_retry"]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.deepEqual(events[0], {
    kind: "rate_limit", method: "GET", path: "tasks/1", status: 429, attempt: 1,
    maxRetries: 1, retryAfterMs: 2_000, willRetry: true,
  });
  assert.equal(client.lastObserverError?.message, "observer failed");
  assert.equal(Object.isFrozen(client.lastObserverError), true);

  const exhaustedEvents: VikunjaClientEvent[] = [];
  const exhausted = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "never-log-this", maxRetries: 0,
    onEvent: (event) => { exhaustedEvents.push(event); },
    fetch: async () => response({ message: "slow down" }, 429, { "retry-after": "3" }),
  });
  await assert.rejects(exhausted.request("GET", "tasks/limited"), VikunjaApiError);
  assert.deepEqual(exhaustedEvents, [{
    kind: "rate_limit", method: "GET", path: "tasks/limited", status: 429, attempt: 1,
    maxRetries: 0, retryAfterMs: 3_000, willRetry: false,
  }]);
  assert.doesNotMatch(JSON.stringify(exhaustedEvents), /never-log-this/u);

  let transportCalls = 0;
  const transport = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "secret-value", maxRetries: 1, delay: async () => undefined,
    fetch: async () => { transportCalls += 1; if (transportCalls === 1) throw new Error("secret-value"); return response({ ok: true }); },
  });
  assert.deepEqual(await transport.request("GET", "tasks/2"), { ok: true });
  assert.equal(transportCalls, 2);

  let writeCalls = 0;
  const write = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "secret-value", maxRetries: 3, delay: async () => undefined,
    fetch: async () => { writeCalls += 1; return response({ message: "busy" }, 503); },
  });
  await assert.rejects(write.request("POST", "tasks/2", {}), VikunjaApiError);
  assert.equal(writeCalls, 1);
});

test("Vikunja client bounds pagination and exhausted timeout retries", async () => {
  const client = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "test", perPage: 1,
    fetch: async () => response([{ id: 1 }], 200, { "x-pagination-total-pages": "2" }),
  });
  await assert.rejects(client.paginate("tasks", {}, { maxPages: 1, maxItems: 10 }), VikunjaPaginationLimitError);

  let calls = 0;
  const timeout = new VikunjaClient({
    baseUrl: "https://vikunja.example.test", token: "test", requestTimeoutMs: 1, maxRetries: 1,
    delay: async () => undefined,
    fetch: async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
  await assert.rejects(timeout.request("GET", "tasks/1"), (error: unknown) => error instanceof VikunjaApiError && error.status === 408);
  assert.equal(calls, 2);
});

test("Vikunja adapter filters and normalizes workflow candidates", async () => {
  const api = new FakeVikunjaApi([
    task(1, "Ready", [1], 5, [{ id: 7, username: "ensemble-bot" }]),
    task(2, "Unmanaged", [], 1),
    task(3, "Blocked", [1], 2, [{ id: 7, username: "ensemble-bot" }], {
      blocked: [task(99, "Dependency", [], 0)],
    }),
    { ...task(4, "Running", [2], 3, [{ id: 7, username: "ensemble-bot" }]), done: true },
  ]);
  const provider = providerFor(api, "execution-a", { requiredAssignee: "ensemble-bot" });
  await provider.validateConfiguration();
  const candidates = await provider.discoverTasks({ scope: "workflow_candidates" });
  assert.deepEqual(candidates.map((item) => item.id), ["1"]);
  assert.equal(candidates[0]?.status, "ready");
  assert.equal(candidates[0]?.priority, -5);
  assert.equal(candidates[0]?.dispatchable, true);
  const blocked = await provider.getTask("3");
  assert.equal(blocked.dispatchable, false);
  assert.deepEqual(blocked.blockers, [{ id: "99", status: "open", resolved: false }]);
});

test("Vikunja task inspection exposes reconstructed state and safe journal metadata only", async () => {
  const api = new FakeVikunjaApi([task(1, "Inspectable", [2], 1)]);
  api.comments.set(1, [
    { id: 10, comment: "operator context", created: "2026-07-31T09:59:00Z", author: { username: "operator" } },
    stateComment(11, activeClaimEvent("execution-1", "owner-secret-value")),
  ]);
  const report = await providerFor(api, "unused").inspectTask("1", { includeJournal: true });
  assert.equal(report.task.id, "1");
  assert.equal(report.execution.active?.id, "execution-1");
  assert.equal(report.execution.active?.startedAt, "2026-07-31T10:00:00.000Z");
  assert.equal(report.commentCount, 1);
  assert.equal(report.artifactCount, 0);
  assert.deepEqual(report.journal, [{
    sequence: 1,
    kind: "claim",
    executionId: "execution-1",
    createdAt: "2026-07-31T10:00:00.000Z",
    role: "implementation",
    ownerId: "owner-secret-value",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  }]);
  assert.doesNotMatch(JSON.stringify(report.journal), /operator context|ensemble-provider-state/u);
});

test("Vikunja discovery recovers active work through status and project routing drift", async () => {
  const api = new FakeVikunjaApi([
    task(1, "Status drift", [], 3),
    { ...task(2, "Moved active", [], 2), project_id: 4 },
    { ...task(3, "Unrelated", [1], 1), project_id: 4 },
  ]);
  api.projects.set(4, { id: 4, title: "Other", is_archived: false });
  api.comments.set(1, [stateComment(1, activeClaimEvent("active-1", "worker-1"))]);
  api.comments.set(2, [stateComment(2, activeClaimEvent("active-2", "worker-2"))]);

  const candidates = await providerFor(api, "unused").discoverTasks({ scope: "workflow_candidates" });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["1", "2"]);
  assert.equal(candidates[0]?.status, "running");
  assert.equal(candidates[0]?.dispatchable, true);
  assert.equal(candidates[1]?.dispatchable, false);
  assert.equal(candidates[1]?.metadata?.projectId, 4);
});

test("Vikunja archive state is authoritative and unarchive restores durable-active discovery", async () => {
  const api = new FakeVikunjaApi([task(1, "Archived active", [], 1)]);
  api.comments.set(1, [stateComment(1, activeClaimEvent("active-1", "worker-1"))]);
  api.projects.set(3, { id: 3, title: "Ensemble", is_archived: true });
  const provider = providerFor(api, "unused");

  await provider.validateConfiguration();
  assert.deepEqual(await provider.discoverTasks({ scope: "workflow_candidates" }), []);
  assert.equal((await provider.refreshTasks(["1"])).get("1")?.kind, "missing");

  api.projects.set(3, { id: 3, title: "Ensemble", is_archived: false });
  const restored = await provider.discoverTasks({ scope: "workflow_candidates" });
  assert.deepEqual(restored.map((candidate) => candidate.id), ["1"]);
  assert.equal(restored[0]?.status, "running");
});

test("Vikunja inventory is bounded, concurrency-limited, and fail-closed", async () => {
  const boundedApi = new FakeVikunjaApi([task(1, "One", [], 1), task(2, "Two", [], 1)]);
  await assert.rejects(
    providerFor(boundedApi, "unused", { inventoryMaxTasks: 1 }).discoverTasks({ scope: "workflow_candidates" }),
    VikunjaPaginationLimitError,
  );

  const projectBoundApi = new FakeVikunjaApi([]);
  projectBoundApi.projects.set(4, { id: 4, title: "Other", is_archived: false });
  await assert.rejects(
    providerFor(projectBoundApi, "unused", { inventoryMaxProjects: 1 }).discoverTasks({ scope: "workflow_candidates" }),
    VikunjaPaginationLimitError,
  );

  const failingApi = new FakeVikunjaApi([task(1, "One", [], 1), task(2, "Two", [], 1)]);
  failingApi.failCommentTaskIds.add(2);
  await assert.rejects(providerFor(failingApi, "unused").discoverTasks({ scope: "workflow_candidates" }), VikunjaApiError);

  const pageFailureApi = new FakeVikunjaApi([task(1, "One", [], 1)]);
  pageFailureApi.failProjectTaskIds.add(3);
  await assert.rejects(providerFor(pageFailureApi, "unused").discoverTasks({ scope: "workflow_candidates" }), VikunjaApiError);

  const concurrentApi = new FakeVikunjaApi(Array.from({ length: 5 }, (_, index) => task(index + 1, `Task ${index + 1}`, [], 1)));
  let release!: () => void;
  concurrentApi.commentReadGate = new Promise<void>((resolve) => { release = resolve; });
  const discovery = providerFor(concurrentApi, "unused", { inventoryConcurrency: 2 })
    .discoverTasks({ scope: "workflow_candidates" });
  for (let attempt = 0; attempt < 10 && concurrentApi.maxConcurrentCommentReads < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(concurrentApi.maxConcurrentCommentReads, 2);
  release();
  await discovery;
});

test("Vikunja workspace inventory includes completed and archived tasks authoritatively", async () => {
  const api = new FakeVikunjaApi([
    task(1, "Current", [1], 1),
    { ...task(2, "Completed", [5], 1), done: true },
    { ...task(3, "Archived", [1], 1), project_id: 4 },
  ]);
  api.projects.set(4, { id: 4, title: "Archived", is_archived: true });
  const result = await providerFor(api, "unused").inventoryTasks();
  assert.equal(result.completeness, "complete");
  assert.deepEqual(result.entries.map((entry) => [entry.task.id, entry.lifecycle]), [
    ["1", "current"], ["2", "terminal"], ["3", "terminal"],
  ]);
  await assert.rejects(providerFor(api, "unused", { inventoryMaxTasks: 2 }).inventoryTasks(), VikunjaPaginationLimitError);
});

test("Vikunja execution journal claims once and synchronizes idempotently", async () => {
  const api = new FakeVikunjaApi([task(1, "Work", [1], 1)]);
  const provider = providerFor(api, "execution-1");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  assert.equal(active.id, "execution-1");
  assert.equal((await provider.getTask("1")).status, "running");

  const completion: ExecutionCompletion = {
    record: {
      id: active.id, role: active.role, outcome: "approved", summary: "Done",
      finishedAt: "2026-07-31T11:00:00.000Z",
    },
    comments: ["Validation passed", "Done"],
    artifacts: [{ type: "pull_request", url: "https://example.test/pr/1" }],
    status: "completed",
  };
  await provider.completeExecution("1", active.id, leaseGuard(active), completion);
  await provider.completeExecution("1", active.id, leaseGuard(active), completion);
  const state = await provider.getExecutionState("1");
  assert.equal(state.active, undefined);
  assert.deepEqual(state.history.map((record) => record.id), ["execution-1"]);
  assert.deepEqual((await provider.getComments("1")).map((comment) => comment.body), ["Validation passed", "Done"]);
  assert.deepEqual(await provider.getArtifacts("1"), completion.artifacts);
  assert.equal((await provider.getTask("1")).status, "completed");
  assert.equal(api.tasks.get(1)?.done, true);
});

test("Vikunja agent tools are claim-scoped, bounded, redacted, and durably idempotent", async () => {
  const credential = "credential-must-never-cross-tool-boundary";
  const api = new FakeVikunjaApi([{ ...task(1, "Work", [1], 1),
    description: `Description ${"é".repeat(6_000)}`, secret: credential }]);
  const provider = providerFor(api, "execution-tools");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  await provider.createComment("1", "Operator context");
  await provider.uploadArtifact("1", { type: "report", url: "https://example.test/report",
    name: "Report", metadata: { credential } });

  const tools = validateRuntimeTools(await provider.getRuntimeTools("1", active.id, active.ownerId!));
  assert.deepEqual(tools.map((tool) => tool.name), [
    "task_read", "task_comments_read", "task_artifacts_read", "task_comment_add",
  ]);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const taskResult = await byName.get("task_read")!.invoke({});
  const commentsResult = await byName.get("task_comments_read")!.invoke({});
  const artifactsResult = await byName.get("task_artifacts_read")!.invoke({});
  assert.ok(Buffer.byteLength((taskResult as { description: string }).description, "utf8") <= 8_192);
  assert.deepEqual((commentsResult as Array<{ body: string }>).map((comment) => comment.body), ["Operator context"]);
  assert.deepEqual(artifactsResult, [{ type: "report", url: "https://example.test/report", name: "Report" }]);
  assert.doesNotMatch(JSON.stringify({ taskResult, commentsResult, artifactsResult }), new RegExp(credential, "u"));

  const add = byName.get("task_comment_add")!;
  const writesBeforeInvalid = api.commentWriteCount;
  await assert.rejects(add.invoke({ body: "Missing key" }), /missing a required property/u);
  assert.equal(api.commentWriteCount, writesBeforeInvalid);
  const overlappingProvider = providerFor(api, "unused");
  const overlappingAdd = validateRuntimeTools(await overlappingProvider.getRuntimeTools("1", active.id, active.ownerId!))
    .find((tool) => tool.name === "task_comment_add")!;
  const [first, concurrentRetry] = await Promise.all([
    add.invoke({ body: "Agent update", idempotencyKey: "update-1" }),
    overlappingAdd.invoke({ body: "Agent update", idempotencyKey: "update-1" }),
  ]);
  assert.deepEqual(concurrentRetry, first);

  const restarted = providerFor(api, "unused");
  const restartedAdd = validateRuntimeTools(await restarted.getRuntimeTools("1", active.id, active.ownerId!))
    .find((tool) => tool.name === "task_comment_add")!;
  assert.deepEqual(await restartedAdd.invoke({ body: "Agent update", idempotencyKey: "update-1" }), first);
  await assert.rejects(restartedAdd.invoke({ body: "Conflicting update", idempotencyKey: "update-1" }),
    /Vikunja tool task_comment_add failed/u);
  assert.equal(api.comments.get(1)?.filter((comment) =>
    String(comment.comment).startsWith("<!-- ensemble-agent-tool:v1:")).length, 1);
  assert.deepEqual((await provider.getComments("1")).map((comment) => comment.body), ["Operator context", "Agent update"]);

  api.failTaskIds.add(1);
  await assert.rejects(byName.get("task_read")!.invoke({}), (error: unknown) => {
    assert.equal((error as Error).message, "Vikunja tool task_read failed");
    assert.doesNotMatch(String(error), /broken|test-token/u);
    return true;
  });
  api.failTaskIds.delete(1);
  await provider.completeExecution("1", active.id, leaseGuard(active), {
    record: { id: active.id, role: active.role, outcome: "approved", summary: "Done",
      finishedAt: "2026-07-31T11:00:00.000Z" },
    comments: [], artifacts: [], status: "completed",
  });
  await assert.rejects(add.invoke({ body: "Too late", idempotencyKey: "late" }),
    /Vikunja tool task_comment_add failed/u);
});

test("Vikunja tool collections enforce an aggregate serialized result budget", async () => {
  const api = new FakeVikunjaApi([task(1, "Large comments", [1], 1)]);
  const provider = providerFor(api, "execution-large-tools");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  const comments = api.comments.get(1)!;
  for (let index = 0; index < 100; index += 1) comments.push({
    id: 1_000 + index,
    comment: `large-${index}-${"\u0001".repeat(8_192)}`,
    created: new Date(Date.UTC(2026, 6, 31, 11, 0, index)).toISOString(),
    author: { id: 7, username: "ensemble-bot" },
  });
  const read = validateRuntimeTools(await provider.getRuntimeTools("1", active.id, active.ownerId!))
    .find((tool) => tool.name === "task_comments_read")!;
  const result = await read.invoke({});
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 196_608);
  assert.ok((result as readonly unknown[]).length < 100);
});

test("Vikunja tools are revoked when the durable lease owner changes", async () => {
  const api = new FakeVikunjaApi([task(1, "Lease takeover", [1], 1)]);
  const provider = providerFor(api, "execution-owner-tools");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  const read = validateRuntimeTools(await provider.getRuntimeTools("1", active.id, active.ownerId!))
    .find((tool) => tool.name === "task_read")!;
  api.comments.get(1)!.push({ ...stateComment(999, {
    protocol: "ensemble-provider-state/v1",
    kind: "claim",
    executionId: active.id,
    role: active.role,
    expected: {
      kind: "leased", executionId: active.id, role: active.role, startedAt: active.startedAt,
      ownerId: active.ownerId, leaseExpiresAt: active.leaseExpiresAt,
    },
    ownerId: "worker-2",
    leaseExpiresAt: "2101-01-01T00:00:00.000Z",
    observedAt: "2100-01-01T00:00:00.000Z",
    createdAt: "2100-01-01T00:00:00.000Z",
  }), created: "2100-01-01T00:00:00.000Z" });
  await assert.rejects(read.invoke({}), /Vikunja tool task_read failed/u);
});

test("Vikunja terminal writers fold concurrent duplicates into one semantic result", async () => {
  const api = new FakeVikunjaApi([task(1, "Concurrent finish", [1], 1)]);
  const provider = providerFor(api, "execution-concurrent");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  const completion: ExecutionCompletion = {
    record: {
      id: active.id, role: active.role, outcome: "approved", summary: "Done",
      finishedAt: "2026-07-31T11:00:00.000Z",
    },
    comments: ["Visible once"],
    artifacts: [{ type: "pull_request", url: "https://example.test/pr/concurrent" }],
    status: "completed",
  };

  await Promise.all([
    provider.completeExecution("1", active.id, leaseGuard(active), completion),
    provider.completeExecution("1", active.id, leaseGuard(active), completion),
  ]);
  assert.equal(rawEvents(api, 1, "complete").length, 2);
  assert.deepEqual((await provider.getComments("1")).map((comment) => comment.body), ["Visible once"]);
  assert.deepEqual(await provider.getArtifacts("1"), completion.artifacts);
  assert.equal((await provider.getExecutionState("1")).history.length, 1);
});

test("Vikunja terminal repair resumes after a status-write failure without duplicating durable effects", async () => {
  const api = new FakeVikunjaApi([task(1, "Repair", [1], 1)]);
  const provider = providerFor(api, "execution-repair");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  const completion: ExecutionCompletion = {
    record: {
      id: active.id, role: active.role, outcome: "approved", summary: "Done",
      finishedAt: "2026-07-31T11:00:00.000Z",
    },
    comments: ["Repair result"],
    artifacts: [{ type: "commit", url: "https://example.test/commit/repair" }],
    status: "completed",
  };
  api.failNextLabelUpdates = 1;

  await assert.rejects(provider.completeExecution("1", active.id, leaseGuard(active), completion), VikunjaApiError);
  assert.equal((await provider.getExecutionState("1")).history.length, 1);
  await provider.completeExecution("1", active.id, leaseGuard(active), completion);

  assert.equal(rawEvents(api, 1, "complete").length, 1);
  assert.deepEqual((await provider.getComments("1")).map((comment) => comment.body), ["Repair result"]);
  assert.deepEqual(await provider.getArtifacts("1"), completion.artifacts);
  assert.equal((await provider.getTask("1")).status, "completed");
});

test("Vikunja suppresses stale losing terminal side effects", async () => {
  const api = new FakeVikunjaApi([task(1, "Stale terminal", [1], 1)]);
  const provider = providerFor(api, "execution-winner");
  const active = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  api.comments.get(1)?.push(stateComment(99, {
    protocol: "ensemble-provider-state/v1",
    kind: "complete",
    executionId: active.id,
    role: active.role,
    createdAt: "2026-07-31T10:30:00.000Z",
    record: {
      id: active.id, role: active.role, outcome: "approved", summary: "Stale",
      finishedAt: "2026-07-31T10:30:00.000Z",
    },
    comments: ["Must stay hidden"],
    artifacts: [{ type: "pull_request", url: "https://example.test/pr/stale" }],
    ownerId: "wrong-owner",
    leaseExpiresAt: active.leaseExpiresAt,
    observedAt: "2026-01-01T00:00:00.000Z",
  }));
  const completion: ExecutionCompletion = {
    record: {
      id: active.id, role: active.role, outcome: "approved", summary: "Winner",
      finishedAt: "2026-07-31T11:00:00.000Z",
    },
    comments: ["Winning result"],
    artifacts: [{ type: "pull_request", url: "https://example.test/pr/winner" }],
    status: "completed",
  };

  await provider.completeExecution("1", active.id, leaseGuard(active), completion);
  assert.deepEqual((await provider.getComments("1")).map((comment) => comment.body), ["Winning result"]);
  assert.deepEqual(await provider.getArtifacts("1"), completion.artifacts);
});

test("Vikunja reconstructs retry, cancellation, blocking, and renewed lease state", async () => {
  const api = new FakeVikunjaApi(Array.from({ length: 4 }, (_, index) => task(index + 1, `Durable ${index + 1}`, [1], 1)));
  const provider = providerFor(api, "execution-durable");

  const failed = await provider.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-1"));
  await provider.failExecution("1", failed.id, leaseGuard(failed), {
    id: failed.id, role: failed.role, outcome: "failed", summary: "Retry later",
    finishedAt: "2026-07-31T11:00:00.000Z",
    failure: { kind: "runtime", retryable: true, nextAttemptAt: "2026-07-31T11:05:00.000Z" },
  }, "failed", "Retry later");

  const cancelled = await provider.beginExecution("2", "implementation", "running", leaseClaim(undefined, "worker-2"));
  await provider.cancelExecution("2", cancelled.id, leaseGuard(cancelled), {
    record: {
      id: cancelled.id, role: cancelled.role, outcome: "cancelled", summary: "Cancelled",
      finishedAt: "2026-07-31T11:00:00.000Z",
    },
    status: "ready", comment: "Cancelled",
  });

  const blocked = await provider.beginExecution("3", "implementation", "running", leaseClaim(undefined, "worker-3"));
  await provider.blockExecution("3", blocked.id, leaseGuard(blocked), {
    record: {
      id: blocked.id, role: blocked.role, outcome: "blocked", summary: "Needs approval",
      finishedAt: "2026-07-31T11:00:00.000Z",
      blockingRequest: {
        kind: "approval", summary: "Approve deployment", requestId: "approval-1",
        createdAt: "2026-07-31T10:59:00.000Z",
      },
    },
    status: "blocked", comment: "Needs approval",
  });

  const leased = await provider.beginExecution("4", "implementation", "running", {
    ownerId: "worker-4", observedAt: "2026-07-31T10:00:00.000Z",
    expiresAt: "2026-07-31T10:01:00.000Z", expected: { kind: "none" },
  });
  await provider.renewExecutionLease("4", leased.id, {
    ownerId: "worker-4", observedAt: "2026-07-31T10:00:30.000Z",
    expiresAt: "2026-07-31T10:02:00.000Z",
    expected: {
      kind: "leased", executionId: leased.id, role: leased.role, startedAt: leased.startedAt,
      ownerId: "worker-4", leaseExpiresAt: "2026-07-31T10:01:00.000Z",
    },
  });

  const restored = providerFor(api, "unused-after-restart");
  assert.deepEqual((await restored.getExecutionState("1")).history[0]?.failure, {
    kind: "runtime", retryable: true, nextAttemptAt: "2026-07-31T11:05:00.000Z",
  });
  assert.equal((await restored.getExecutionState("2")).history[0]?.outcome, "cancelled");
  assert.equal((await restored.getExecutionState("3")).history[0]?.blockingRequest?.requestId, "approval-1");
  assert.equal((await restored.getExecutionState("4")).active?.leaseExpiresAt, "2026-07-31T10:02:00.000Z");
});

test("Vikunja canonicalizes provider comment timestamps across renewal, restart, and takeover", async () => {
  const api = new FakeVikunjaApi([
    task(1, "Whole-second lease", [1], 1),
    task(2, "Expired takeover", [1], 1),
    task(3, "Millisecond lease", [1], 1),
    task(4, "Invalid timestamp", [1], 1),
  ]);
  api.commentCreatedAt = () => "2026-08-02T10:43:35Z";
  const provider = providerFor(api, "whole-second");
  const active = await provider.beginExecution("1", "implementation", "running", {
    ownerId: "worker-1", observedAt: "2026-08-02T10:43:34.000Z",
    expiresAt: "2026-08-02T10:44:34.000Z", expected: { kind: "none" },
  });
  assert.equal(active.startedAt, "2026-08-02T10:43:35.000Z");
  const renewed = await provider.renewExecutionLease("1", active.id, {
    ownerId: "worker-1", observedAt: "2026-08-02T10:43:55.000Z",
    expiresAt: "2026-08-02T10:44:55.000Z", expected: leaseClaim(active, "worker-1").expected,
  });
  assert.equal(rawEvents(api, 1, "lease").length, 1);
  assert.equal(renewed.leaseExpiresAt, "2026-08-02T10:44:55.000Z");

  const restored = providerFor(api, "unused-after-restart");
  const restoredActive = (await restored.getExecutionState("1")).active!;
  assert.equal(restoredActive.startedAt, "2026-08-02T10:43:35.000Z");
  const renewedAgain = await restored.renewExecutionLease("1", restoredActive.id, {
    ownerId: "worker-1", observedAt: "2026-08-02T10:44:15.000Z",
    expiresAt: "2026-08-02T10:45:15.000Z", expected: leaseClaim(restoredActive, "worker-1").expected,
  });
  assert.equal(renewedAgain.leaseExpiresAt, "2026-08-02T10:45:15.000Z");
  assert.equal(rawEvents(api, 1, "lease").length, 2);

  const expired = await provider.beginExecution("2", "implementation", "running", {
    ownerId: "expired-owner", observedAt: "2026-08-02T10:40:00.000Z",
    expiresAt: "2026-08-02T10:41:00.000Z", expected: { kind: "none" },
  });
  const taken = await restored.beginExecution("2", "ignored", "running", {
    ownerId: "new-owner", observedAt: "2026-08-02T10:41:00.000Z",
    expiresAt: "2026-08-02T10:42:00.000Z", expected: leaseClaim(expired, "new-owner").expected,
  });
  assert.deepEqual({ id: taken.id, role: taken.role, startedAt: taken.startedAt },
    { id: expired.id, role: expired.role, startedAt: "2026-08-02T10:43:35.000Z" });

  api.commentCreatedAt = () => "2026-08-02T10:43:35.123Z";
  const millisecond = await provider.beginExecution("3", "implementation", "running", leaseClaim(undefined, "worker-3"));
  assert.equal(millisecond.startedAt, "2026-08-02T10:43:35.123Z");

  api.comments.set(4, [{ ...stateComment(999, activeClaimEvent("invalid", "worker-4")), created: "not-a-date" }]);
  await assert.rejects(provider.getExecutionState("4"), /Invalid Vikunja comment created/u);
});

test("Vikunja append-only claims deterministically reject a competing claimant", async () => {
  const api = new FakeVikunjaApi([task(1, "Race", [1], 1)]);
  const left = providerFor(api, "claim-left");
  const right = providerFor(api, "claim-right");
  const settled = await Promise.allSettled([
    left.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-left")),
    right.beginExecution("1", "implementation", "running", leaseClaim(undefined, "worker-right")),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  assert.ok(rejected?.reason instanceof ProviderClaimConflict);
  const state = await left.getExecutionState("1");
  assert.ok(state.active?.id === "claim-left" || state.active?.id === "claim-right");
});

test("Vikunja expired takeover has one winner and preserves the execution identity", async () => {
  const api = new FakeVikunjaApi([task(1, "Takeover", [1], 1)]);
  const original = providerFor(api, "original-id");
  const active = await original.beginExecution("1", "implementation", "running", {
    ...leaseClaim(undefined, "expired-owner"), expiresAt: "2026-01-01T00:00:10.000Z",
  });
  const left = providerFor(api, "unused-left");
  const right = providerFor(api, "unused-right");
  const settled = await Promise.allSettled([
    left.beginExecution("1", "ignored", "running", {
      ...leaseClaim(active, "takeover-left"), observedAt: "2026-01-01T00:00:10.000Z", expiresAt: "2026-01-01T00:01:10.000Z",
    }),
    right.beginExecution("1", "ignored", "running", {
      ...leaseClaim(active, "takeover-right"), observedAt: "2026-01-01T00:00:10.000Z", expiresAt: "2026-01-01T00:01:10.000Z",
    }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const winner = (await original.getExecutionState("1")).active;
  assert.equal(winner?.id, active.id);
  assert.equal(winner?.role, active.role);
  assert.equal(winner?.startedAt, active.startedAt);
  assert.ok(winner?.ownerId === "takeover-left" || winner?.ownerId === "takeover-right");
});

test("Vikunja reconciliation distinguishes current, missing, and unreadable tasks", async () => {
  const api = new FakeVikunjaApi([task(1, "Current", [1], 1)]);
  api.failTaskIds.add(3);
  const refreshed = await providerFor(api, "execution").refreshTasks(["3", "2", "1"]);
  assert.equal(refreshed.get("1")?.kind, "current");
  assert.equal(refreshed.get("2")?.kind, "missing");
  assert.equal(refreshed.get("3")?.kind, "unreadable");
  assert.deepEqual([...refreshed.keys()], ["1", "2", "3"]);
});

test("Vikunja adapter rejects malformed provider-owned execution state", async () => {
  const api = new FakeVikunjaApi([task(1, "Malformed", [1], 1)]);
  api.comments.set(1, [{
    id: 1,
    comment: "<!-- ensemble-provider-state:v1\n{not-json}\n-->",
    created: "2026-07-31T10:00:00.000Z",
    author: { id: 7, username: "ensemble-bot" },
  }]);
  await assert.rejects(providerFor(api, "execution").getExecutionState("1"), /Malformed Ensemble provider state/u);
});

test("Vikunja rejects inconsistent and non-exact durable blocking records", async () => {
  const api = new FakeVikunjaApi([task(1, "Malformed block", [3], 1)]);
  const base = { id: "blocked-1", role: "implementation", summary: "Approve", nextRole: "implementation",
    finishedAt: "2026-07-31T10:00:00.000Z" };
  const request = { kind: "approval", summary: "Approve", requestId: "approval-1",
    createdAt: "2026-07-31T10:00:00.000Z" };
  const records = [
    { ...base, outcome: "blocked" },
    { ...base, outcome: "completed", blockingRequest: request },
    { ...base, outcome: "blocked", blockingRequest: { ...request, providerCredential: "secret" } },
  ];
  for (const [index, record] of records.entries()) {
    api.comments.set(1, [stateComment(index + 1, {
      protocol: "ensemble-provider-state/v1", kind: "block", executionId: record.id,
      createdAt: record.finishedAt, record,
    })]);
    await assert.rejects(providerFor(api, "execution").getExecutionState("1"), /Invalid (Vikunja execution record|blocking request)/u);
  }
});

test("Vikunja execution state accepts legacy failures and validates present retry details", async () => {
  const api = new FakeVikunjaApi([task(1, "Failure state", [4], 1)]);
  const record = {
    id: "legacy-failure",
    role: "implementation",
    outcome: "failed",
    summary: "legacy",
    finishedAt: "2026-07-31T10:00:00.000Z",
  };
  api.comments.set(1, [stateComment(1, {
    protocol: "ensemble-provider-state/v1",
    kind: "fail",
    executionId: record.id,
    createdAt: record.finishedAt,
    record,
  })]);
  assert.equal((await providerFor(api, "execution").getExecutionState("1")).history[0]?.failure, undefined);

  for (const [index, failure] of [
    { kind: "runtime", retryable: true },
    { kind: "runtime", retryable: true, nextAttemptAt: "2026-01-01" },
  ].entries()) {
    api.comments.set(1, [stateComment(index + 2, {
      protocol: "ensemble-provider-state/v1",
      kind: "fail",
      executionId: "invalid-failure",
      createdAt: "2026-07-31T10:00:01.000Z",
      record: { ...record, id: "invalid-failure", failure },
    })]);
    await assert.rejects(providerFor(api, "execution").getExecutionState("1"), /Invalid Vikunja execution record/u);
  }
});

function providerFor(api: FakeVikunjaApi, executionId: string, extra: Partial<VikunjaProviderOptions> = {}): VikunjaProvider {
  return new VikunjaProvider({
    baseUrl: "https://vikunja.example.test",
    token: "test-token",
    projectId: 3,
    viewId: 9,
    repository,
    fetch: api.fetch,
    maxRetries: 0,
    executionId: () => executionId,
    now: () => new Date("2026-07-31T10:00:00.000Z"),
    ...extra,
  });
}

function task(
  id: number,
  title: string,
  labelIds: readonly number[],
  priority: number,
  assignees: readonly { id: number; username: string }[] = [],
  relatedTasks: Readonly<Record<string, readonly unknown[]>> = {},
): Record<string, unknown> {
  return {
    id, identifier: `ENS-${id}`, title, description: `Description ${id}`, done: false, priority, project_id: 3,
    labels: statusLabels.filter((label) => labelIds.includes(label.id)), assignees, related_tasks: relatedTasks,
  };
}

function stateComment(id: number, event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id,
    comment: `<!-- ensemble-provider-state:v1\n${JSON.stringify(event)}\n-->`,
    created: "2026-07-31T10:00:00.000Z",
    author: { id: 7, username: "ensemble-bot" },
  };
}

function activeClaimEvent(executionId: string, ownerId: string): Readonly<Record<string, unknown>> {
  return {
    protocol: "ensemble-provider-state/v1",
    kind: "claim",
    executionId,
    role: "implementation",
    expected: { kind: "none" },
    ownerId,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    observedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-07-31T10:00:00.000Z",
  };
}

function rawEvents(api: FakeVikunjaApi, taskId: number, kind: string): readonly Record<string, unknown>[] {
  return (api.comments.get(taskId) ?? []).filter((comment) =>
    typeof comment.comment === "string" && comment.comment.includes(`\"kind\":\"${kind}\"`));
}

class FakeVikunjaApi {
  readonly tasks = new Map<number, Record<string, unknown>>();
  readonly projects = new Map<number, Record<string, unknown>>([[3, { id: 3, title: "Ensemble", is_archived: false }]]);
  readonly comments = new Map<number, Array<Record<string, unknown>>>();
  readonly failTaskIds = new Set<number>();
  readonly failCommentTaskIds = new Set<number>();
  readonly failProjectTaskIds = new Set<number>();
  commentReadGate?: Promise<void>;
  maxConcurrentCommentReads = 0;
  failNextLabelUpdates = 0;
  commentWriteCount = 0;
  commentCreatedAt = (id: number): string => new Date(Date.UTC(2026, 6, 31, 10, 0, id)).toISOString();
  #concurrentCommentReads = 0;
  #commentId = 0;

  constructor(tasks: readonly Record<string, unknown>[]) {
    for (const item of tasks) this.tasks.set(item.id as number, structuredClone(item));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v1/", "");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");

    if (method === "GET" && path === "projects") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const all = [...this.projects.values()];
      return response(all.slice((page - 1) * perPage, page * perPage), 200, {
        "x-pagination-total-pages": String(Math.max(1, Math.ceil(all.length / perPage))),
      });
    }
    const projectMatch = /^projects\/(\d+)$/u.exec(path);
    if (method === "GET" && projectMatch) {
      const project = this.projects.get(Number(projectMatch[1]));
      return project ? response(project) : response({ message: "not found" }, 404);
    }
    if (method === "GET" && path === "projects/3/views") return response([{ id: 9, title: "List", view_kind: "list" }]);
    if (method === "GET" && path === "labels") return response(statusLabels);
    if (method === "GET" && path === "projects/3/views/9/tasks") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const all = [...this.tasks.values()].filter((item) => item.project_id === 3 && item.done !== true);
      return response(all.slice((page - 1) * perPage, page * perPage), 200, {
        "x-pagination-total-pages": String(Math.max(1, Math.ceil(all.length / perPage))),
      });
    }
    const projectTasksMatch = /^projects\/(\d+)\/tasks$/u.exec(path);
    if (method === "GET" && projectTasksMatch) {
      const projectId = Number(projectTasksMatch[1]);
      if (this.failProjectTaskIds.has(projectId)) return response({ message: "broken" }, 500);
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const all = [...this.tasks.values()].filter((item) => item.project_id === projectId);
      return response(all.slice((page - 1) * perPage, page * perPage), 200, {
        "x-pagination-total-pages": String(Math.max(1, Math.ceil(all.length / perPage))),
      });
    }

    const taskMatch = /^tasks\/(\d+)$/u.exec(path);
    if (taskMatch) {
      const id = Number(taskMatch[1]);
      if (this.failTaskIds.has(id)) return response({ message: "broken" }, 500);
      const existing = this.tasks.get(id);
      if (!existing) return response({ message: "not found" }, 404);
      if (method === "GET") return response(existing);
      if (method === "POST") {
        Object.assign(existing, parseBody(init));
        return response(existing);
      }
    }

    const commentsMatch = /^tasks\/(\d+)\/comments$/u.exec(path);
    if (commentsMatch) {
      const id = Number(commentsMatch[1]);
      if (!this.tasks.has(id)) return response({ message: "not found" }, 404);
      const comments = this.comments.get(id) ?? [];
      if (method === "GET") {
        if (this.failCommentTaskIds.has(id)) return response({ message: "broken" }, 500);
        this.#concurrentCommentReads += 1;
        this.maxConcurrentCommentReads = Math.max(this.maxConcurrentCommentReads, this.#concurrentCommentReads);
        try {
          await this.commentReadGate;
          return response(comments);
        } finally {
          this.#concurrentCommentReads -= 1;
        }
      }
      if (method === "PUT") {
        this.commentWriteCount += 1;
        const body = parseBody(init);
        this.#commentId += 1;
        const comment = {
          id: this.#commentId,
          comment: body.comment,
          created: this.commentCreatedAt(this.#commentId),
          author: { id: 7, username: "ensemble-bot" },
        };
        comments.push(comment);
        this.comments.set(id, comments);
        await Promise.resolve();
        return response(comment, 201);
      }
    }

    const commentMatch = /^tasks\/(\d+)\/comments\/(\d+)$/u.exec(path);
    if (commentMatch && method === "DELETE") {
      const taskId = Number(commentMatch[1]);
      const commentId = Number(commentMatch[2]);
      const comments = this.comments.get(taskId) ?? [];
      const index = comments.findIndex((comment) => comment.id === commentId);
      if (index < 0) return response({ message: "not found" }, 404);
      comments.splice(index, 1);
      this.comments.set(taskId, comments);
      return response({ message: "deleted" });
    }

    const labelsMatch = /^tasks\/(\d+)\/labels\/bulk$/u.exec(path);
    if (labelsMatch && method === "POST") {
      const existing = this.tasks.get(Number(labelsMatch[1]));
      if (!existing) return response({ message: "not found" }, 404);
      if (this.failNextLabelUpdates > 0) {
        this.failNextLabelUpdates -= 1;
        return response({ message: "temporary failure" }, 503);
      }
      const ids = (parseBody(init).labels as Array<{ id: number }>).map((label) => label.id);
      existing.labels = statusLabels.filter((label) => ids.includes(label.id));
      return response({ labels: existing.labels }, 201);
    }
    return response({ message: `unhandled ${method} ${path}` }, 500);
  };
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function response(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
