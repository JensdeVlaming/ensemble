import assert from "node:assert/strict";
import test from "node:test";
import {
  generateLaunchdPlist,
  generateLaunchdLogRotationPlist,
  generateNewsyslogConfiguration,
  generateSystemdUnit,
  LaunchdServiceManager,
  serviceManagerFor,
  SystemdServiceManager,
} from "../src/index.ts";
import type { ServiceFileSystem, ServiceInstallOptions, ServiceProcessRunner } from "../src/index.ts";

const options: ServiceInstallOptions = {
  nodeExecutable: "/usr/bin/node",
  cliEntrypoint: "/opt/ensemble/dist/cli.js",
  configPath: "/etc/ensemble/config.yaml",
  environmentPath: "/etc/ensemble/ensemble.env",
  statePath: "/var/lib/ensemble",
  workspacePath: "/var/lib/ensemble/workspaces",
  logPath: "/Users/test/Library/Logs/Ensemble",
  stopTimeoutSeconds: 45,
};

class FakeRunner implements ServiceProcessRunner {
  readonly calls: Array<{ executable: string; arguments_: readonly string[]; inherit: boolean }> = [];
  userExists = false;
  async run(executable: string, arguments_: readonly string[], processOptions: { readonly inherit?: boolean } = {}) {
    this.calls.push({ executable, arguments_, inherit: processOptions.inherit ?? false });
    if (executable.endsWith("/id")) return { code: this.userExists ? 0 : 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  }
}

class FakeFiles implements ServiceFileSystem {
  readonly writes: Array<{ path: string; content: string; mode: number }> = [];
  readonly removes: string[] = [];
  readonly directories: string[] = [];
  async mkdir(path: string) { this.directories.push(path); }
  async write(path: string, content: string, mode: number) { this.writes.push({ path, content, mode }); }
  async remove(path: string) { this.removes.push(path); }
}

test("systemd unit is hardened, restartable, absolute, and contains no credentials", () => {
  const unit = generateSystemdUnit(options);
  assert.match(unit, /User=ensemble/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /TimeoutStopSec=45s/u);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/ensemble\/dist\/cli.js" "run"/u);
  assert.doesNotMatch(unit, /TOKEN|secret-value/u);
});

test("launchd plist uses argv, restarts failures, and keeps credentials out", () => {
  const plist = generateLaunchdPlist(options);
  assert.match(plist, /dev\.ensemble\.service/u);
  assert.match(plist, /<key>RunAtLoad<\/key>/u);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/u);
  assert.match(plist, /<string>\/etc\/ensemble\/config.yaml<\/string>/u);
  assert.match(plist, /ensemble-error\.log/u);
  assert.doesNotMatch(plist, /VIKUNJA_API_TOKEN|secret-value/u);
});

test("macOS log rotation is bounded and scheduled", () => {
  const plist = generateLaunchdLogRotationPlist(options.logPath!);
  assert.match(plist, /newsyslog/u);
  assert.match(plist, /3600/u);
  assert.match(generateNewsyslogConfiguration(options.logPath!), /ensemble-error\.log 600 7 10240/u);
});

test("systemd installation is idempotent and testable through injected boundaries", async () => {
  const runner = new FakeRunner();
  const files = new FakeFiles();
  const manager = new SystemdServiceManager(runner, files);
  await manager.install(options);
  assert.ok(runner.calls.some((call) => call.executable.endsWith("groupadd")));
  assert.ok(runner.calls.some((call) => call.executable.endsWith("useradd")));
  assert.ok(runner.calls.some((call) => call.arguments_.includes("daemon-reload")));
  assert.equal(files.writes[0]?.path, SystemdServiceManager.unitPath);
  await manager.uninstall();
  assert.deepEqual(files.removes, [SystemdServiceManager.unitPath]);
});

test("launchd installation and platform selection stay behind one adapter", async () => {
  const runner = new FakeRunner();
  const files = new FakeFiles();
  const manager = new LaunchdServiceManager(501, "/Users/test", runner, files);
  await manager.install(options);
  assert.ok(runner.calls.some((call) => call.arguments_.includes("bootstrap")));
  assert.match(files.writes[0]?.path ?? "", /Library\/LaunchAgents\/dev\.ensemble\.service\.plist$/u);
  assert.ok(files.writes.some((write) => write.path.endsWith("newsyslog.conf")));
  assert.ok(serviceManagerFor("linux", { runner, files }) instanceof SystemdServiceManager);
  assert.ok(serviceManagerFor("darwin", { userId: 501, home: "/Users/test", runner, files }) instanceof LaunchdServiceManager);
  assert.throws(() => serviceManagerFor("win32"), /unsupported/u);
});
