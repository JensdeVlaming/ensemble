import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceGuard, inspectInstanceGuard } from "../src/index.ts";

test("instance guard excludes concurrent controllers and releases idempotently", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-instance-"));
  const first = await acquireInstanceGuard(state);
  await assert.rejects(acquireInstanceGuard(state), /already running/u);
  await first.release();
  await first.release();
  const second = await acquireInstanceGuard(state);
  await second.release();
});

test("instance guard inspection distinguishes stopped, running, stale, and invalid state", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-instance-inspect-"));
  assert.equal((await inspectInstanceGuard(state)).state, "stopped");
  const guard = await acquireInstanceGuard(state);
  const running = await inspectInstanceGuard(state);
  assert.equal(running.state, "running");
  assert.equal(running.pid, process.pid);
  await guard.release();

  await writeFile(join(state, "service.lock"), "424242:11111111-1111-4111-8111-111111111111\n", { mode: 0o600 });
  assert.equal((await inspectInstanceGuard(state, { processAlive: () => false })).state, "stale");
  await writeFile(join(state, "service.lock"), "not-a-lock\n", { mode: 0o600 });
  assert.equal((await inspectInstanceGuard(state)).state, "invalid");
});
