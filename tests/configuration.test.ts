import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryConfigLoader } from "../src/index.ts";
import type { RepositoryRef } from "../src/index.ts";

const repository: RepositoryRef = { id: "configuration", url: "local://configuration" };

async function fixture(configuration: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-configuration-"));
  await mkdir(join(root, ".ensemble", "roles"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Test configuration.");
  await writeFile(join(root, ".ensemble", "WORKFLOW.md"), "Execute safely.");
  await writeFile(join(root, ".ensemble", "roles", "implementation.md"), "Implement.");
  await writeFile(join(root, ".ensemble", "config.yaml"), [
    "runtime:",
    "  name: scripted",
    "initialRole: implementation",
    ...configuration,
  ].join("\n"));
  return root;
}

async function load(configuration: readonly string[]) {
  return new RepositoryConfigLoader().load(repository, await fixture(configuration));
}

test("repository configuration exposes every section 17 policy as typed values", async () => {
  const config = await load([
    "statuses:",
    "  runnable: [ready, running]",
    "  running: running",
    "  completed: completed",
    "  failed: failed",
    "  blocked: awaiting_operator",
    "service:",
    "  pollIntervalMs: 0",
    "concurrency:",
    "  global: 0",
    "  byStatus:",
    "    ready: 0",
    "    running: 2",
    "retry:",
    "  maxFailedAttemptsPerRole: 0",
    "  initialDelayMs: 0",
    "  maxDelayMs: 0",
    "  multiplier: 1",
    "  jitterRatio: 0",
    "  retryableFailureKinds: [configuration, reconciliation, shutdown]",
    "timeouts:",
    "  startupMs: 0",
    "  providerMs: 1",
    "  runtimeStartMs: 2",
    "  turnMs: 3",
    "  stallMs: 4",
    "  cancellationMs: 5",
    "shutdown:",
    "  drainTimeoutMs: 0",
    "workspace:",
    "  hooks:",
    "    afterCreate:",
    "      executable: npm",
    "      args: [install]",
    "    beforeRun:",
    "      executable: npm",
    "      args: []",
    "    afterRun:",
    "      executable: node",
    "      args: [report.js]",
    "    beforeRemove:",
    "      executable: git",
    "      args: [status, --short]",
    "  hookTimeoutMs: 0",
  ]);

  assert.equal(config.blockedStatus, "awaiting_operator");
  assert.deepEqual(config.service, { pollIntervalMs: 0 });
  assert.deepEqual(config.concurrency, { global: 0, byStatus: { ready: 0, running: 2 } });
  assert.deepEqual(config.retry, {
    maxFailedAttemptsPerRole: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    multiplier: 1,
    jitterRatio: 0,
    retryableFailureKinds: ["configuration", "reconciliation", "shutdown"],
  });
  assert.deepEqual(config.timeouts, {
    startupMs: 0,
    providerMs: 1,
    runtimeStartMs: 2,
    turnMs: 3,
    stallMs: 4,
    cancellationMs: 5,
  });
  assert.deepEqual(config.shutdown, { drainTimeoutMs: 0 });
  assert.deepEqual(config.workspace, {
    hooks: {
      afterCreate: { executable: "npm", args: ["install"] },
      beforeRun: { executable: "npm", args: [] },
      afterRun: { executable: "node", args: ["report.js"] },
      beforeRemove: { executable: "git", args: ["status", "--short"] },
    },
    hookTimeoutMs: 0,
  });
});

test("repository configuration installs the documented section 17 defaults", async () => {
  const config = await load([]);
  assert.equal(config.blockedStatus, "blocked");
  assert.deepEqual(config.service, { pollIntervalMs: 30_000 });
  assert.deepEqual(config.concurrency, { global: 10, byStatus: {} });
  assert.deepEqual(config.retry, {
    maxFailedAttemptsPerRole: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 300_000,
    multiplier: 2,
    jitterRatio: 0.2,
    retryableFailureKinds: ["startup", "provider", "runtime", "timeout", "stalled"],
  });
  assert.deepEqual(config.timeouts, {
    startupMs: 30_000,
    providerMs: 30_000,
    runtimeStartMs: 30_000,
    turnMs: 3_600_000,
    stallMs: 300_000,
    cancellationMs: 10_000,
  });
  assert.deepEqual(config.shutdown, { drainTimeoutMs: 30_000 });
  assert.deepEqual(config.workspace, { hooks: {}, hookTimeoutMs: 60_000 });
});

test("every integer policy rejects negative and unsafe values", async () => {
  const fields = [
    ["service", "pollIntervalMs"],
    ["concurrency", "global"],
    ["retry", "maxFailedAttemptsPerRole"],
    ["retry", "initialDelayMs"],
    ["retry", "maxDelayMs"],
    ["timeouts", "startupMs"],
    ["timeouts", "providerMs"],
    ["timeouts", "runtimeStartMs"],
    ["timeouts", "turnMs"],
    ["timeouts", "stallMs"],
    ["timeouts", "cancellationMs"],
    ["shutdown", "drainTimeoutMs"],
    ["workspace", "hookTimeoutMs"],
  ] as const;

  for (const [section, field] of fields) {
    await assert.rejects(load([`${section}:`, `  ${field}: -1`]), new RegExp(`${section}\\.${field}`, "u"));
  }
  await assert.rejects(load(["service:", "  pollIntervalMs: 1.5"]), /service\.pollIntervalMs/u);
  await assert.rejects(load(["service:", "  pollIntervalMs: Infinity"]), /service\.pollIntervalMs/u);
  await assert.rejects(load(["service:", "  pollIntervalMs: 9007199254740992"]), /service\.pollIntervalMs/u);
  assert.equal((await load(["service:", "  pollIntervalMs: 9007199254740991"])).service.pollIntervalMs, Number.MAX_SAFE_INTEGER);
});

test("retry, concurrency, failure kinds, and mappings enforce their boundaries", async () => {
  await assert.rejects(load(["retry:", "  multiplier: 0.999"]), /retry\.multiplier/u);
  await assert.rejects(load(["retry:", "  multiplier: Infinity"]), /retry\.multiplier/u);
  assert.equal((await load(["retry:", "  multiplier: 1"])).retry.multiplier, 1);

  for (const value of ["-0.1", "1.1", "Infinity"]) {
    await assert.rejects(load(["retry:", `  jitterRatio: ${value}`]), /retry\.jitterRatio/u);
  }
  assert.equal((await load(["retry:", "  jitterRatio: 1"])).retry.jitterRatio, 1);

  await assert.rejects(load(["retry:", "  retryableFailureKinds: [runtime, unknown]"]), /failure kind list/u);
  assert.deepEqual((await load(["retry:", "  retryableFailureKinds: []"])).retry.retryableFailureKinds, []);

  await assert.rejects(load(["concurrency:", "  byStatus:", "    ready: -1"]), /concurrency\.byStatus\.ready/u);
  await assert.rejects(load(["concurrency:", "  byStatus:", "    ready: 1.5"]), /concurrency\.byStatus\.ready/u);
  await assert.rejects(load(["service: invalid"]), /Expected mapping: service/u);
  await assert.rejects(load(["statuses:", "  blocked: \"\""]), /non-empty string: blocked/u);
});

test("explicit null values never install defaults", async () => {
  const invalidNulls: ReadonlyArray<readonly [readonly string[], RegExp]> = [
    [["service:", "  pollIntervalMs: null"], /service\.pollIntervalMs/u],
    [["retry:", "  multiplier: null"], /retry\.multiplier/u],
    [["statuses:", "  blocked: null"], /non-empty string: blocked/u],
    [["terminalOutcomes: null"], /string list: terminalOutcomes/u],
    [["retry:", "  retryableFailureKinds: null"], /failure kind list/u],
    [["workspace:", "  hooks:", "    beforeRun:", "      executable: npm", "      args: null"], /string list: args/u],
  ];
  for (const [configuration, expected] of invalidNulls) {
    await assert.rejects(load(configuration), expected);
  }
});

test("workspace hook definitions require executable plus non-empty string args", async () => {
  const invalidHooks = [
    ["workspace:", "  hooks:", "    beforeRun:", "      args: [install]"],
    ["workspace:", "  hooks:", "    beforeRun:", "      executable: \"\"", "      args: [install]"],
    ["workspace:", "  hooks:", "    beforeRun:", "      executable: npm"],
    ["workspace:", "  hooks:", "    beforeRun:", "      executable: npm", "      args: install"],
    ["workspace:", "  hooks:", "    beforeRun:", "      executable: npm", "      args: [install, \"\"]"],
  ];
  for (const configuration of invalidHooks) {
    await assert.rejects(load(configuration), /non-empty string|string list/u);
  }
});
