import { spawn } from "node:child_process";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ServiceInstallOptions {
  readonly nodeExecutable: string;
  readonly cliEntrypoint: string;
  readonly configPath: string;
  readonly environmentPath: string;
  readonly statePath: string;
  readonly workspacePath: string;
  readonly logPath?: string;
  readonly stopTimeoutSeconds?: number;
}

export interface ServiceCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServiceProcessRunner {
  run(executable: string, arguments_: readonly string[], options?: { readonly inherit?: boolean }): Promise<ServiceCommandResult>;
}

export interface ServiceFileSystem {
  mkdir(path: string, options: { readonly recursive: boolean; readonly mode: number }): Promise<unknown>;
  write(path: string, content: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface PlatformServiceManager {
  install(options: ServiceInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceCommandResult>;
  verify(): Promise<ServiceCommandResult>;
  logs(): Promise<void>;
}

export class NodeServiceProcessRunner implements ServiceProcessRunner {
  run(executable: string, arguments_: readonly string[], options: { readonly inherit?: boolean } = {}): Promise<ServiceCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, [...arguments_], {
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      if (!options.inherit) {
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      }
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(Object.freeze({ code: code ?? 1, stdout, stderr })));
    });
  }
}

export const nodeServiceFileSystem: ServiceFileSystem = {
  mkdir: (path, options) => mkdir(path, options),
  write: async (path, content, mode) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFile(path, content, { encoding: "utf8", mode });
    await chmod(path, mode);
  },
  remove: async (path) => { await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  }); },
};

export class SystemdServiceManager implements PlatformServiceManager {
  static readonly unitPath = "/etc/systemd/system/ensemble.service";
  readonly #runner: ServiceProcessRunner;
  readonly #files: ServiceFileSystem;

  constructor(runner: ServiceProcessRunner = new NodeServiceProcessRunner(), files: ServiceFileSystem = nodeServiceFileSystem) {
    this.#runner = runner;
    this.#files = files;
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    validateInstallOptions(options);
    await requireSuccess(this.#runner, "/usr/sbin/groupadd", ["--system", "--force", "ensemble"], "create Ensemble group");
    const user = await this.#runner.run("/usr/bin/id", ["-u", "ensemble"]);
    if (user.code !== 0) {
      await requireSuccess(this.#runner, "/usr/sbin/useradd", [
        "--system", "--gid", "ensemble", "--home-dir", options.statePath,
        "--shell", "/usr/sbin/nologin", "ensemble",
      ], "create Ensemble user");
    }
    await requireSuccess(this.#runner, "/usr/bin/install", [
      "-d", "-m", "0750", "-o", "root", "-g", "ensemble", dirname(options.configPath),
    ], `create ${dirname(options.configPath)}`);
    for (const path of [options.statePath, options.workspacePath]) {
      await requireSuccess(this.#runner, "/usr/bin/install", ["-d", "-m", "0750", "-o", "ensemble", "-g", "ensemble", path],
        `create ${path}`);
    }
    for (const path of [options.configPath, options.environmentPath]) {
      await requireSuccess(this.#runner, "/usr/bin/chown", ["root:ensemble", path], `secure ownership for ${path}`);
      await requireSuccess(this.#runner, "/usr/bin/chmod", ["0640", path], `secure permissions for ${path}`);
    }
    await this.#files.write(SystemdServiceManager.unitPath, generateSystemdUnit(options), 0o644);
    await requireSuccess(this.#runner, "/usr/bin/systemctl", ["daemon-reload"], "reload systemd");
    await requireSuccess(this.#runner, "/usr/bin/systemctl", ["enable", "ensemble.service"], "enable Ensemble service");
  }

  async uninstall(): Promise<void> {
    await this.#runner.run("/usr/bin/systemctl", ["disable", "--now", "ensemble.service"]);
    await this.#files.remove(SystemdServiceManager.unitPath);
    await requireSuccess(this.#runner, "/usr/bin/systemctl", ["daemon-reload"], "reload systemd");
  }
  async start(): Promise<void> { await requireSuccess(this.#runner, "/usr/bin/systemctl", ["start", "ensemble.service"], "start Ensemble"); }
  async stop(): Promise<void> { await requireSuccess(this.#runner, "/usr/bin/systemctl", ["stop", "ensemble.service"], "stop Ensemble"); }
  async restart(): Promise<void> { await requireSuccess(this.#runner, "/usr/bin/systemctl", ["restart", "ensemble.service"], "restart Ensemble"); }
  status(): Promise<ServiceCommandResult> { return this.#runner.run("/usr/bin/systemctl", ["status", "--no-pager", "ensemble.service"]); }
  verify(): Promise<ServiceCommandResult> { return this.#runner.run("/usr/bin/systemctl", ["is-enabled", "ensemble.service"]); }
  async logs(): Promise<void> { await requireSuccess(this.#runner, "/usr/bin/journalctl", ["-u", "ensemble.service", "-n", "200", "-f"],
    "read Ensemble logs", true); }
}

export class LaunchdServiceManager implements PlatformServiceManager {
  static readonly label = "dev.ensemble.service";
  static readonly logRotationLabel = "dev.ensemble.log-rotation";
  readonly #userId: number;
  readonly #home: string;
  readonly #runner: ServiceProcessRunner;
  readonly #files: ServiceFileSystem;
  #logPath?: string;

  constructor(userId: number, home: string, runner: ServiceProcessRunner = new NodeServiceProcessRunner(),
    files: ServiceFileSystem = nodeServiceFileSystem) {
    this.#userId = userId;
    this.#home = home;
    this.#runner = runner;
    this.#files = files;
  }

  get plistPath(): string { return resolve(this.#home, "Library", "LaunchAgents", `${LaunchdServiceManager.label}.plist`); }
  get domain(): string { return `gui/${this.#userId}`; }
  get target(): string { return `${this.domain}/${LaunchdServiceManager.label}`; }
  get logRotationPlistPath(): string { return resolve(this.#home, "Library", "LaunchAgents", `${LaunchdServiceManager.logRotationLabel}.plist`); }

  async install(options: ServiceInstallOptions): Promise<void> {
    validateInstallOptions(options);
    if (!options.logPath) throw new Error("macOS service installation requires logPath");
    this.#logPath = options.logPath;
    await this.#files.mkdir(options.logPath, { recursive: true, mode: 0o700 });
    await this.#files.write(this.plistPath, generateLaunchdPlist(options), 0o600);
    await this.#files.write(this.logRotationPlistPath, generateLaunchdLogRotationPlist(options.logPath), 0o600);
    await this.#files.write(resolve(options.logPath, "newsyslog.conf"), generateNewsyslogConfiguration(options.logPath), 0o600);
    await this.#runner.run("/bin/launchctl", ["bootout", this.domain, this.plistPath]);
    await requireSuccess(this.#runner, "/bin/launchctl", ["bootstrap", this.domain, this.plistPath], "install Ensemble LaunchAgent");
    await requireSuccess(this.#runner, "/bin/launchctl", ["enable", this.target], "enable Ensemble LaunchAgent");
    await this.#runner.run("/bin/launchctl", ["bootout", this.domain, this.logRotationPlistPath]);
    await requireSuccess(this.#runner, "/bin/launchctl", ["bootstrap", this.domain, this.logRotationPlistPath], "install Ensemble log rotation");
    await requireSuccess(this.#runner, "/bin/launchctl", ["enable", `${this.domain}/${LaunchdServiceManager.logRotationLabel}`], "enable Ensemble log rotation");
  }
  async uninstall(): Promise<void> {
    await this.#runner.run("/bin/launchctl", ["bootout", this.domain, this.plistPath]);
    await this.#runner.run("/bin/launchctl", ["bootout", this.domain, this.logRotationPlistPath]);
    await this.#files.remove(this.plistPath);
    await this.#files.remove(this.logRotationPlistPath);
  }
  async start(): Promise<void> { await requireSuccess(this.#runner, "/bin/launchctl", ["kickstart", "-k", this.target], "start Ensemble"); }
  async stop(): Promise<void> { await requireSuccess(this.#runner, "/bin/launchctl", ["kill", "SIGTERM", this.target], "stop Ensemble"); }
  async restart(): Promise<void> { await this.start(); }
  status(): Promise<ServiceCommandResult> { return this.#runner.run("/bin/launchctl", ["print", this.target]); }
  verify(): Promise<ServiceCommandResult> { return this.#runner.run("/bin/launchctl", ["print", this.target]); }
  async logs(): Promise<void> {
    const directory = this.#logPath ?? resolve(this.#home, "Library", "Logs", "Ensemble");
    await requireSuccess(this.#runner, "/usr/bin/tail", ["-n", "200", "-f",
      resolve(directory, "ensemble.log"), resolve(directory, "ensemble-error.log")], "read Ensemble logs", true);
  }
}

export function serviceManagerFor(
  platform: NodeJS.Platform,
  options: { readonly userId?: number; readonly home?: string; readonly runner?: ServiceProcessRunner; readonly files?: ServiceFileSystem } = {},
): PlatformServiceManager {
  if (platform === "linux") return new SystemdServiceManager(options.runner, options.files);
  if (platform === "darwin") {
    if (options.userId === undefined || !options.home) throw new Error("macOS service management requires user ID and home path");
    return new LaunchdServiceManager(options.userId, options.home, options.runner, options.files);
  }
  throw new Error(`Service management is unsupported on ${platform}; use 'ensemble run' in the foreground`);
}

export function generateSystemdUnit(options: ServiceInstallOptions): string {
  validateInstallOptions(options);
  const stop = options.stopTimeoutSeconds ?? 60;
  return [
    "[Unit]",
    "Description=Ensemble orchestration service",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=ensemble",
    "Group=ensemble",
    `WorkingDirectory=${systemdArgument(options.statePath)}`,
    `ExecStart=${[options.nodeExecutable, options.cliEntrypoint, "run", "--config", options.configPath,
      "--env-file", options.environmentPath].map(systemdArgument).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5s",
    `TimeoutStopSec=${positiveInteger(stop, "stopTimeoutSeconds")}s`,
    "KillSignal=SIGTERM",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    `ReadOnlyPaths=${systemdArgument(options.configPath)} ${systemdArgument(options.environmentPath)}`,
    `ReadWritePaths=${systemdArgument(options.statePath)} ${systemdArgument(options.workspacePath)}`,
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function generateLaunchdPlist(options: ServiceInstallOptions): string {
  validateInstallOptions(options);
  if (!options.logPath) throw new Error("macOS service installation requires logPath");
  const arguments_ = [options.nodeExecutable, options.cliEntrypoint, "run", "--config", options.configPath,
    "--env-file", options.environmentPath];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>", `  <string>${xml(LaunchdServiceManager.label)}</string>`,
    "  <key>ProgramArguments</key>", "  <array>",
    ...arguments_.map((argument) => `    <string>${xml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>", `  <string>${xml(options.statePath)}</string>`,
    "  <key>RunAtLoad</key>", "  <true/>",
    "  <key>KeepAlive</key>", "  <dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key>", "  <integer>5</integer>",
    "  <key>ProcessType</key>", "  <string>Background</string>",
    "  <key>StandardOutPath</key>", `  <string>${xml(resolve(options.logPath, "ensemble.log"))}</string>`,
    "  <key>StandardErrorPath</key>", `  <string>${xml(resolve(options.logPath, "ensemble-error.log"))}</string>`,
    "</dict>", "</plist>", "",
  ].join("\n");
}

export function generateLaunchdLogRotationPlist(logPath: string): string {
  validateAbsolutePath(logPath, "logPath");
  const configuration = resolve(logPath, "newsyslog.conf");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist version=\"1.0\"><dict>",
    "<key>Label</key>", `  <string>${xml(LaunchdServiceManager.logRotationLabel)}</string>`,
    "<key>ProgramArguments</key><array>", "  <string>/usr/bin/newsyslog</string>", `  <string>-f</string><string>${xml(configuration)}</string>`, "</array>",
    "<key>StartInterval</key><integer>3600</integer>",
    "</dict></plist>", "",
  ].join("\n");
}

export function generateNewsyslogConfiguration(logPath: string): string {
  validateAbsolutePath(logPath, "logPath");
  return `${resolve(logPath, "ensemble.log")} 600 7 10240 * Z\n${resolve(logPath, "ensemble-error.log")} 600 7 10240 * Z\n`;
}

function validateInstallOptions(options: ServiceInstallOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (name === "stopTimeoutSeconds" || name === "logPath" && value === undefined) continue;
    if (typeof value === "string" && (!value.startsWith("/") || /[\0\r\n]/u.test(value))) {
      throw new Error(`Service installation requires a safe absolute ${name}`);
    }
  }
}

function validateAbsolutePath(value: string, name: string): void {
  if (!value.startsWith("/") || /[\0\r\n]/u.test(value)) throw new Error(`${name} must be a safe absolute path`);
}

function systemdArgument(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw new Error("Invalid systemd argument");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function requireSuccess(
  runner: ServiceProcessRunner,
  executable: string,
  arguments_: readonly string[],
  action: string,
  inherit = false,
): Promise<void> {
  const result = await runner.run(executable, arguments_, { inherit });
  if (result.code !== 0) throw new Error(`Unable to ${action} (exit ${result.code}): ${bounded(result.stderr)}`);
}

function bounded(value: string): string { return value.length <= 1_024 ? value.trim() : `${value.slice(0, 1_023).trim()}…`; }
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
