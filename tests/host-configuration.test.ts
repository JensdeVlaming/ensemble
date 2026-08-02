import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultHostPaths,
  loadEnvironmentFile,
  parseHostConfiguration,
  runtimeEnvironment,
} from "../src/index.ts";

function host(overrides: readonly string[] = []): string {
  return [
    "version: 1",
    "service:",
    "  startupTimeoutMs: 30000",
    "  stopTimeoutSeconds: 60",
    "logging:",
    "  level: info",
    "workspace:",
    "  root: /var/lib/ensemble/workspaces",
    "  preserve: true",
    "  gitExecutable: /usr/bin/git",
    "runtimes:",
    "  - name: codex",
    "    type: codex-app-server",
    "    executable: /usr/local/bin/codex",
    "    serverArguments: [app-server, --listen, stdio://]",
    "    requestTimeoutMs: 45000",
    "    environment:",
    "      inherit: [PATH, HOME, CODEX_HOME, SSH_AUTH_SOCK]",
    "repositories:",
    "  - id: ensemble",
    "    url: https://github.com/example/ensemble.git",
    "    branch: main",
    "    configurationPath: /srv/ensemble",
    "    provider:",
    "      type: vikunja",
    "      baseUrl: https://vikunja.example.test",
    "      token: $VIKUNJA_API_TOKEN",
    "      projectId: 3",
    "      viewId: 9",
    "      requiredLabels: [ensemble:ready]",
    ...overrides,
  ].join("\n");
}

test("host configuration is strict, immutable, and keeps runtime selection operator-owned", () => {
  const configuration = parseHostConfiguration(host());
  assert.equal(configuration.version, 1);
  assert.equal(configuration.repositories[0]?.provider.projectId, 3);
  assert.equal(configuration.runtimes[0]?.name, "codex");
  assert.equal(configuration.runtimes[0]?.type, "codex-app-server");
  assert.deepEqual(configuration.runtimes[0]?.serverArguments, ["app-server", "--listen", "stdio://"]);
  assert.equal(configuration.runtimes[0]?.requestTimeoutMs, 45_000);
  assert.equal(configuration.logging.level, "info");
  assert.equal(configuration.service.stopTimeoutSeconds, 60);
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.repositories[0]?.provider.requiredLabels), true);

  assert.throws(() => parseHostConfiguration(`${host()}\nunexpected: true`), /Unknown host configuration key/u);
  assert.throws(() => parseHostConfiguration(host().replace("/srv/ensemble", "relative")), /absolute path/u);
  assert.throws(() => parseHostConfiguration(host().replace("$VIKUNJA_API_TOKEN", "literal-token")), /secret reference/u);
  assert.throws(() => parseHostConfiguration(host().replace("CODEX_HOME, SSH_AUTH_SOCK", "CODEX_HOME, VIKUNJA_API_TOKEN")),
    /Forbidden runtime environment variable/u);
  assert.throws(() => parseHostConfiguration(host().replace("- name: codex", "- name: codex\n  - name: codex")), /type|unique/u);
  assert.throws(() => parseHostConfiguration(host().replace("level: info", "level: trace")), /logging\.level/u);
});

test("host configuration rejects the removed Codex CLI runtime", () => {
  const source = host().replace("type: codex-app-server", "type: codex-cli");
  assert.throws(() => parseHostConfiguration(source), /Unsupported runtime type/u);
});

test("environment files are non-shell, bounded, duplicate-free, and permission checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-host-env-"));
  const path = join(root, "ensemble.env");
  await writeFile(path, "# secrets\nVIKUNJA_API_TOKEN=value\nEMPTY=\n", { mode: 0o600 });
  const environment = await loadEnvironmentFile(path, { platform: "darwin", userId: process.getuid?.() });
  assert.deepEqual({ ...environment }, { VIKUNJA_API_TOKEN: "value", EMPTY: "" });

  await chmod(path, 0o644);
  await assert.rejects(loadEnvironmentFile(path, { platform: "darwin", userId: process.getuid?.() }), /permissions/u);
  await chmod(path, 0o600);
  await writeFile(path, "TOKEN=one\nTOKEN=two\n");
  await assert.rejects(loadEnvironmentFile(path, { platform: "darwin", userId: process.getuid?.() }), /Duplicate/u);
  await writeFile(path, "export TOKEN=value\n");
  await assert.rejects(loadEnvironmentFile(path, { platform: "darwin", userId: process.getuid?.() }), /Invalid environment record/u);
  const link = join(root, "linked.env");
  await symlink(path, link);
  await assert.rejects(loadEnvironmentFile(link, { platform: "darwin", userId: process.getuid?.() }), /non-symlink/u);
});

test("runtime environments are explicit and provider credential families are rejected", () => {
  assert.deepEqual({ ...runtimeEnvironment(["PATH", "HOME", "SSH_AUTH_SOCK"], {
    PATH: "/bin", HOME: "/service", SSH_AUTH_SOCK: "/socket", VIKUNJA_API_TOKEN: "secret",
  }) }, { PATH: "/bin", HOME: "/service", SSH_AUTH_SOCK: "/socket" });
  assert.throws(() => runtimeEnvironment(["VIKUNJA_API_TOKEN"], { VIKUNJA_API_TOKEN: "secret" }), /Forbidden/u);
  assert.throws(() => runtimeEnvironment(["OPENAI_API_KEY"], { OPENAI_API_KEY: "secret" }), /Forbidden/u);
});

test("platform defaults follow Linux, macOS, and portable foreground conventions", () => {
  assert.deepEqual(defaultHostPaths("linux", "/home/test"), {
    configuration: "/etc/ensemble/config.yaml", environment: "/etc/ensemble/ensemble.env",
    state: "/var/lib/ensemble", workspaces: "/var/lib/ensemble/workspaces",
  });
  assert.match(defaultHostPaths("darwin", "/Users/test").configuration, /Library\/Application Support\/Ensemble\/config.yaml$/u);
  assert.match(defaultHostPaths("win32", "/Users/test").configuration, /\.ensemble\/config.yaml$/u);
});
