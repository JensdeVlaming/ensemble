import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceGuard } from "../src/index.ts";

test("instance guard excludes concurrent controllers and releases idempotently", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-instance-"));
  const first = await acquireInstanceGuard(state);
  await assert.rejects(acquireInstanceGuard(state), /already running/u);
  await first.release();
  await first.release();
  const second = await acquireInstanceGuard(state);
  await second.release();
});
