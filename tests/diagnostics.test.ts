import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnoseHost, hostStatus } from "../src/index.ts";
import type { HostConfiguration, HostController } from "../src/index.ts";

test("host diagnostics run filesystem, provider, configuration, and runtime checks without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-diagnostics-"));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  const configurationPath = join(root, "repository-config");
  const executable = join(root, "executable");
  await Promise.all([mkdir(state), mkdir(workspace), mkdir(configurationPath), writeFile(executable, "#!/bin/sh\n")]);
  await chmod(executable, 0o700);
  const configuration = hostConfiguration(workspace, configurationPath, executable);
  let providerChecks = 0;
  let reloads = 0;
  let runtimeChecks = 0;
  const controller = {
    configuration,
    secrets: { redact: (value: string) => value.replaceAll("sensitive-value", "[REDACTED]") },
    repositories: [{
      provider: { repository: { id: "repo" }, validateConfiguration: async () => { providerChecks += 1; } },
      scheduler: { reloadConfiguration: async () => { reloads += 1; } },
    }],
    runtimes: { get: () => ({ diagnose: async ({ cwd }: { cwd: string }) => {
      runtimeChecks += 1;
      assert.equal(cwd, configurationPath);
    } }) },
  } as unknown as HostController;

  const report = await diagnoseHost(controller, state);
  assert.equal(report.healthy, true);
  assert.equal(report.checks.every((check) => check.status === "pass"), true);
  assert.equal(providerChecks, 1);
  assert.equal(reloads, 1);
  assert.equal(runtimeChecks, 1);
});

test("host diagnostics retain independent failures and redact their details", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-diagnostics-failure-"));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  const configurationPath = join(root, "repository-config");
  const executable = join(root, "executable");
  await Promise.all([mkdir(state), mkdir(workspace), mkdir(configurationPath), writeFile(executable, "#!/bin/sh\n")]);
  await chmod(executable, 0o700);
  const configuration = hostConfiguration(workspace, configurationPath, executable);
  let runtimeChecked = false;
  const controller = {
    configuration,
    secrets: { redact: (value: string) => value.replaceAll("sensitive-value", "[REDACTED]") },
    repositories: [{
      provider: { repository: { id: "repo" }, validateConfiguration: async () => { throw new Error("sensitive-value denied"); } },
      scheduler: { reloadConfiguration: async () => { throw new Error("invalid repository configuration"); } },
    }],
    runtimes: { get: () => ({ diagnose: async () => { runtimeChecked = true; } }) },
  } as unknown as HostController;

  const report = await diagnoseHost(controller, state);
  assert.equal(report.healthy, false);
  assert.equal(runtimeChecked, true);
  assert.equal(report.checks.filter((check) => check.status === "fail").length, 2);
  assert.match(JSON.stringify(report), /\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(report), /sensitive-value/u);
});

test("host status remains available when configuration loading failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-status-"));
  const report = await hostStatus(join(root, "missing.yaml"), root, undefined, new Error("invalid configuration"));
  assert.equal(report.controller.state, "stopped");
  assert.equal(report.configurationError, "invalid configuration");
  assert.equal(report.workspacePath, undefined);
});

function hostConfiguration(workspace: string, configurationPath: string, executable: string): HostConfiguration {
  return {
    version: 1,
    service: { startupTimeoutMs: 30_000, stopTimeoutSeconds: 60 },
    logging: { level: "info" },
    workspace: { root: workspace, preserve: true, gitExecutable: executable },
    runtimes: [{ name: "codex", type: "codex-app-server", executable,
      serverArguments: ["app-server", "--listen", "stdio://"], requestTimeoutMs: 30_000,
      environment: { inherit: [] } }],
    repositories: [{ id: "repo", url: "https://example.test/repo.git", configurationPath,
      provider: { type: "vikunja", baseUrl: "https://vikunja.example.test", token: "$TOKEN",
        projectId: 1, viewId: 1, requiredLabels: [] } }],
  };
}
