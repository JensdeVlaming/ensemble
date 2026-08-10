import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorService } from "../src/orchestration/service.ts";

const scheduler = () => ({
  async reloadConfiguration() {
    return { status: "installed" as const, revision: "r1", operationalPolicy: {
      startupTimeoutMs: 100, pollIntervalMs: 100, drainTimeoutMs: 100, cancellationTimeoutMs: 100,
    } };
  },
  async startup() { return { recoveredExecutionIds: [] as string[], validatedTaskIds: [] as string[] }; },
  async tick() { return { dispatchedTaskIds: [] as string[] }; },
  async shutdown() { return { drained: true, cancelledTaskIds: [], remainingTaskIds: [] }; },
});

test("service snapshot is immutable and reports readiness and counters", async () => {
  const service = new OrchestratorService([{ id: "repo", scheduler: scheduler(), startupTimeoutMs: 100,
    pollIntervalMs: 100, drainTimeoutMs: 100, cancellationTimeoutMs: 100 }], undefined, undefined);
  assert.equal(service.snapshot(() => new Date("2026-01-01T00:00:00.000Z")).readiness, false);
  await service.tick();
  const beforeStart = service.snapshot();
  assert.equal(beforeStart.metrics.tick_success_total, 1);
  assert.throws(() => (beforeStart.repositories as unknown as Array<unknown>).push({}), TypeError);
  const running = service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(service.snapshot().readiness, true);
  await service.shutdown();
  await running;
  assert.equal(service.snapshot().service, "stopped");
});
