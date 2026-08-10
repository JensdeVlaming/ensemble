import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isCliEntrypoint, runCli } from "../src/cli.ts";

class Output {
  value = "";
  write(chunk: string): void { this.value += chunk; }
}

test("CLI help and init create protected non-secret local configuration without overwriting", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-cli-"));
  const config = join(home, "config.yaml");
  const environment = join(home, "ensemble.env");
  const stdout = new Output();
  const stderr = new Output();
  const context = {
    platform: "darwin" as const,
    home,
    environment: { PATH: "/usr/bin:/usr/local/bin" },
    userId: process.getuid?.(),
    groupIds: process.getgroups?.(),
    io: { stdout, stderr },
  };

  assert.equal(await runCli(["--help"], context), 0);
  assert.match(stdout.value, /service install/u);
  assert.match(stdout.value, /inspect task/u);
  stdout.value = "";
  assert.equal(await runCli(["init", "--config", config, "--env-file", environment], context), 0);
  assert.match(await readFile(config, "utf8"), /type: vikunja/u);
  assert.equal(await readFile(environment, "utf8"), [
    "# Ensemble controller values; this file is not shell syntax.",
    "VIKUNJA_API_TOKEN=",
    `CODEX_HOME=${join(home, "Library", "Application Support", "Ensemble", "state", "codex")}`,
    "",
  ].join("\n"));
  assert.equal((await stat(environment)).mode & 0o777, 0o600);

  await writeFile(environment, "VIKUNJA_API_TOKEN=preserve-me\n", { mode: 0o600 });
  assert.equal(await runCli(["init", "--config", config, "--env-file", environment], context), 0);
  assert.equal(await readFile(environment, "utf8"), "VIKUNJA_API_TOKEN=preserve-me\n");
  assert.equal(stderr.value, "");
});

test("CLI status remains machine-readable without configuration and diagnostic flags are scoped", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-cli-status-"));
  const stdout = new Output();
  const stderr = new Output();
  const context = { platform: "darwin" as const, home, io: { stdout, stderr } };
  assert.equal(await runCli(["status", "--json"], context), 1);
  const report = JSON.parse(stdout.value) as { controller: { state: string }; configurationError?: string };
  assert.equal(report.controller.state, "stopped");
  assert.equal(typeof report.configurationError, "string");
  assert.equal(stderr.value, "");

  stdout.value = "";
  assert.equal(await runCli(["doctor", "--json"], context), 1);
  const doctor = JSON.parse(stdout.value) as { healthy: boolean; checks: Array<{ id: string; status: string }> };
  assert.equal(doctor.healthy, false);
  assert.deepEqual(doctor.checks.map((check) => check.id), ["host.environment", "host.configuration"]);
  assert.equal(doctor.checks.every((check) => check.status === "fail"), true);

  stdout.value = "";
  assert.equal(await runCli(["validate", "--journal"], context), 1);
  assert.match(stderr.value, /only valid with inspect task/u);
});

test("CLI rejects relative paths and unsupported service management without leaking input", async () => {
  const stdout = new Output();
  const stderr = new Output();
  assert.equal(await runCli(["validate", "--config", "relative"], {
    platform: "linux", home: "/home/test", io: { stdout, stderr },
  }), 1);
  assert.match(stderr.value, /absolute path/u);
  stderr.value = "";
  assert.equal(await runCli(["service", "status"], {
    platform: "win32", home: "C:/Users/test", io: { stdout, stderr },
  }), 1);
  assert.match(stderr.value, /unsupported/u);
});

test("CLI recognizes npm-style symlinked bin entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-cli-link-"));
  const target = join(root, "dist-cli.js");
  const link = join(root, "ensemble");
  await writeFile(target, "#!/usr/bin/env node\n");
  await symlink(target, link);
  assert.equal(isCliEntrypoint(link, target), true);
  assert.equal(isCliEntrypoint(undefined, target), false);
});
