import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderClaimConflict,
  VikunjaApiError,
  VikunjaClient,
  VikunjaProvider,
} from "../src/index.ts";
import type { ExecutionCompletion, RepositoryRef } from "../src/index.ts";

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

test("Vikunja execution journal claims once and synchronizes idempotently", async () => {
  const api = new FakeVikunjaApi([task(1, "Work", [1], 1)]);
  const provider = providerFor(api, "execution-1");
  const active = await provider.beginExecution("1", "implementation", "running");
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
  await provider.completeExecution("1", active.id, completion);
  await provider.completeExecution("1", active.id, completion);
  const state = await provider.getExecutionState("1");
  assert.equal(state.active, undefined);
  assert.deepEqual(state.history.map((record) => record.id), ["execution-1"]);
  assert.deepEqual((await provider.getComments("1")).map((comment) => comment.body), ["Validation passed", "Done"]);
  assert.deepEqual(await provider.getArtifacts("1"), completion.artifacts);
  assert.equal((await provider.getTask("1")).status, "completed");
  assert.equal(api.tasks.get(1)?.done, true);
});

test("Vikunja append-only claims deterministically reject a competing claimant", async () => {
  const api = new FakeVikunjaApi([task(1, "Race", [1], 1)]);
  const left = providerFor(api, "claim-left");
  const right = providerFor(api, "claim-right");
  const settled = await Promise.allSettled([
    left.beginExecution("1", "implementation", "running"),
    right.beginExecution("1", "implementation", "running"),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  assert.ok(rejected?.reason instanceof ProviderClaimConflict);
  const state = await left.getExecutionState("1");
  assert.ok(state.active?.id === "claim-left" || state.active?.id === "claim-right");
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

function providerFor(api: FakeVikunjaApi, executionId: string, extra: { requiredAssignee?: string } = {}): VikunjaProvider {
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

class FakeVikunjaApi {
  readonly tasks = new Map<number, Record<string, unknown>>();
  readonly comments = new Map<number, Array<Record<string, unknown>>>();
  readonly failTaskIds = new Set<number>();
  #commentId = 0;

  constructor(tasks: readonly Record<string, unknown>[]) {
    for (const item of tasks) this.tasks.set(item.id as number, structuredClone(item));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v1/", "");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");

    if (method === "GET" && path === "projects/3") return response({ id: 3, title: "Ensemble", is_archived: false });
    if (method === "GET" && path === "projects/3/views") return response([{ id: 9, title: "List", view_kind: "list" }]);
    if (method === "GET" && path === "labels") return response(statusLabels);
    if (method === "GET" && path === "projects/3/views/9/tasks") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const all = [...this.tasks.values()].filter((item) => item.done !== true);
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
      if (method === "GET") return response(comments);
      if (method === "PUT") {
        const body = parseBody(init);
        this.#commentId += 1;
        const comment = {
          id: this.#commentId,
          comment: body.comment,
          created: new Date(Date.UTC(2026, 6, 31, 10, 0, this.#commentId)).toISOString(),
          author: { id: 7, username: "ensemble-bot" },
        };
        comments.push(comment);
        this.comments.set(id, comments);
        await Promise.resolve();
        return response(comment, 201);
      }
    }

    const labelsMatch = /^tasks\/(\d+)\/labels\/bulk$/u.exec(path);
    if (labelsMatch && method === "POST") {
      const existing = this.tasks.get(Number(labelsMatch[1]));
      if (!existing) return response({ message: "not found" }, 404);
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
