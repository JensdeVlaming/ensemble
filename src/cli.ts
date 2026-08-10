#!/usr/bin/env node
import { access, mkdir, open } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultHostPaths,
  loadEnvironmentFile,
  loadHostConfiguration,
} from "./host/configuration.ts";
import type { HostPaths } from "./host/configuration.ts";
import {
  buildHostController,
  initializeHostDirectories,
  validateHostFilesystem,
} from "./host/service.ts";
import { acquireInstanceGuard } from "./host/instance.ts";
import { diagnoseHost, hostStatus } from "./host/diagnostics.ts";
import type { DiagnosticCheck, DoctorReport, HostStatusReport } from "./host/diagnostics.ts";
import type { ProviderTaskDiagnostic } from "./providers/provider.ts";
import { serviceManagerFor } from "./host/service-manager.ts";
import type { ServiceInstallOptions } from "./host/service-manager.ts";

export interface CliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
}

export interface CliContext {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly userId?: number;
  readonly groupIds?: readonly number[];
  readonly nodeExecutable?: string;
  readonly cliEntrypoint?: string;
  readonly io?: CliIo;
}

interface ParsedArguments {
  readonly command: string;
  readonly subcommand?: string;
  readonly target?: string;
  readonly repositoryId?: string;
  readonly json: boolean;
  readonly journal: boolean;
  readonly configPath: string;
  readonly environmentPath: string;
  readonly paths: HostPaths;
}

export async function runCli(arguments_: readonly string[], context: CliContext = {}): Promise<number> {
  const platform = context.platform ?? process.platform;
  const home = context.home ?? homedir();
  const io = context.io ?? { stdout: process.stdout, stderr: process.stderr };
  try {
    const parsed = parseArguments(arguments_, defaultHostPaths(platform, home));
    validateCommandArguments(parsed);
    if (parsed.command === "help") { io.stdout.write(help()); return 0; }
    if (parsed.command === "init") {
      await initializeFiles(parsed, platform, context.environment ?? process.env);
      io.stdout.write(`Initialized Ensemble configuration at ${parsed.configPath}\n`);
      return 0;
    }
    if (parsed.command === "service") {
      return await serviceCommand(parsed, { ...context, platform, home, io });
    }
    if (parsed.command === "status") {
      let configuration;
      let configurationError: unknown;
      try { configuration = await loadHostConfiguration(parsed.configPath); }
      catch (error) { configurationError = error; }
      const report = await hostStatus(parsed.configPath, parsed.paths.state, configuration, configurationError);
      io.stdout.write(parsed.json ? `${JSON.stringify(report)}\n` : formatStatus(report));
      return configurationError === undefined && report.controller.state !== "invalid" ? 0 : 1;
    }
    if (parsed.command === "doctor") return await doctorCommand(parsed, { ...context, platform, io });
    if (parsed.command !== "validate" && parsed.command !== "run" && parsed.command !== "inspect") {
      throw new Error(`Unknown command: ${parsed.command}`);
    }
    const fileEnvironment = await loadEnvironmentFile(parsed.environmentPath, {
      platform,
      ...(context.userId === undefined ? {} : { userId: context.userId }),
      ...(context.groupIds === undefined ? {} : { groupIds: context.groupIds }),
    });
    // The protected file is authoritative for explicitly configured controller values.
    const environment = Object.freeze({ ...(context.environment ?? process.env), ...fileEnvironment });
    const configuration = await loadHostConfiguration(parsed.configPath);
    if (parsed.command === "run") await initializeHostDirectories(configuration, parsed.paths.state);
    if (parsed.command !== "inspect") await validateHostFilesystem(configuration);
    const controller = await buildHostController(configuration, {
      environment,
      writable: parsed.command === "inspect" ? { write: () => true } : io.stdout,
    });
    if (parsed.command === "validate") {
      await controller.validate();
      io.stdout.write("Ensemble configuration is valid\n");
      return 0;
    }
    if (parsed.command === "inspect") {
      if (parsed.subcommand !== "task" || !parsed.target) throw new Error("Usage: ensemble inspect task <task-id>");
      const repository = selectRepository(controller, parsed.repositoryId);
      if (!repository.provider.inspectTask) throw new Error(`Provider does not support task inspection: ${repository.provider.name}`);
      const report = await repository.provider.inspectTask(parsed.target, { includeJournal: parsed.journal });
      const projection = taskDiagnosticProjection(repository.provider.repository.id, repository.provider.name, report);
      io.stdout.write(parsed.json ? `${JSON.stringify(projection)}\n` : formatTaskDiagnostic(projection));
      return 0;
    }
    const guard = await acquireInstanceGuard(parsed.paths.state);
    try {
      await controller.run();
      return 0;
    } finally {
      await guard.release();
    }
  } catch (error) {
    io.stderr.write(`Ensemble: ${boundedError(error)}\n`);
    return 1;
  }
}

async function doctorCommand(
  parsed: ParsedArguments,
  context: CliContext & { readonly platform: NodeJS.Platform; readonly io: CliIo },
): Promise<number> {
  const checks: DiagnosticCheck[] = [];
  let fileEnvironment: Readonly<Record<string, string>> | undefined;
  let configuration: Awaited<ReturnType<typeof loadHostConfiguration>> | undefined;
  try {
    fileEnvironment = await loadEnvironmentFile(parsed.environmentPath, {
      platform: context.platform,
      ...(context.userId === undefined ? {} : { userId: context.userId }),
      ...(context.groupIds === undefined ? {} : { groupIds: context.groupIds }),
    });
    checks.push(Object.freeze({ id: "host.environment", status: "pass", detail: "Protected environment file is valid" }));
  } catch (error) {
    checks.push(Object.freeze({ id: "host.environment", status: "fail", detail: boundedError(error) }));
  }
  try {
    configuration = await loadHostConfiguration(parsed.configPath);
    checks.push(Object.freeze({ id: "host.configuration", status: "pass", detail: "Host configuration is valid" }));
  } catch (error) {
    checks.push(Object.freeze({ id: "host.configuration", status: "fail", detail: boundedError(error) }));
  }
  if (fileEnvironment && configuration) {
    const environment = Object.freeze({ ...(context.environment ?? process.env), ...fileEnvironment });
    try {
      const controller = await buildHostController(configuration, { environment, writable: { write: () => true } });
      checks.push(...(await diagnoseHost(controller, parsed.paths.state)).checks);
    } catch (error) {
      checks.push(Object.freeze({ id: "host.controller", status: "fail", detail: boundedError(error) }));
    }
  }
  const report: DoctorReport = Object.freeze({
    healthy: !checks.some((check) => check.status === "fail"),
    checks: Object.freeze(checks),
  });
  context.io.stdout.write(parsed.json ? `${JSON.stringify(report)}\n` : formatDoctor(report));
  return report.healthy ? 0 : 1;
}

async function serviceCommand(parsed: ParsedArguments, context: Required<Pick<CliContext, "platform" | "home" | "io">> & CliContext): Promise<number> {
  const action = parsed.subcommand;
  if (!action || !["install", "uninstall", "start", "stop", "restart", "status", "logs"].includes(action)) {
    throw new Error("Expected service action: install, uninstall, start, stop, restart, status, or logs");
  }
  const manager = serviceManagerFor(context.platform, {
    ...(context.userId === undefined ? { userId: process.getuid?.() } : { userId: context.userId }),
    home: context.home,
  });
  if (action === "install") {
    const configuration = await loadHostConfiguration(parsed.configPath);
    const options: ServiceInstallOptions = {
      nodeExecutable: resolve(context.nodeExecutable ?? process.execPath),
      cliEntrypoint: resolve(context.cliEntrypoint ?? fileURLToPath(import.meta.url)),
      configPath: parsed.configPath,
      environmentPath: parsed.environmentPath,
      statePath: parsed.paths.state,
      workspacePath: configuration.workspace.root,
      stopTimeoutSeconds: configuration.service.stopTimeoutSeconds,
      ...(parsed.paths.logs ? { logPath: parsed.paths.logs } : {}),
    };
    await manager.install(options);
    context.io.stdout.write("Ensemble service installed\n");
    return 0;
  }
  if (action === "uninstall") await manager.uninstall();
  else if (action === "start") await manager.start();
  else if (action === "stop") await manager.stop();
  else if (action === "restart") await manager.restart();
  else if (action === "logs") await manager.logs();
  else {
    const status = await manager.status();
    context.io.stdout.write(status.stdout || status.stderr);
    const configuration = await loadHostConfiguration(parsed.configPath);
    context.io.stdout.write(`Configuration: ${parsed.configPath}\nState: ${parsed.paths.state}\nWorkspace: ${configuration.workspace.root}\n`);
    return status.code === 0 ? 0 : 1;
  }
  context.io.stdout.write(`Ensemble service ${action} complete\n`);
  return 0;
}

function parseArguments(arguments_: readonly string[], defaults: HostPaths): ParsedArguments {
  const positionals: string[] = [];
  let configPath = defaults.configuration;
  let environmentPath = defaults.environment;
  let repositoryId: string | undefined;
  let json = false;
  let journal = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--config" || argument === "--env-file" || argument === "--repository") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === "--repository") repositoryId = value;
      else {
        if (!value.startsWith("/")) throw new Error(`${argument} requires an absolute path`);
        if (argument === "--config") configPath = resolve(value);
        else environmentPath = resolve(value);
      }
      index += 1;
      continue;
    }
    if (argument === "--json") { json = true; continue; }
    if (argument === "--journal") { journal = true; continue; }
    if (argument === "--help" || argument === "-h") return { command: "help", configPath, environmentPath, paths: defaults, json, journal };
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positionals.push(argument);
  }
  if (positionals.length > 3) throw new Error(`Unexpected argument: ${positionals[3]}`);
  return {
    command: positionals[0] ?? "help",
    ...(positionals[1] ? { subcommand: positionals[1] } : {}),
    ...(positionals[2] ? { target: positionals[2] } : {}),
    ...(repositoryId ? { repositoryId } : {}),
    json,
    journal,
    configPath,
    environmentPath,
    paths: defaults,
  };
}

function validateCommandArguments(parsed: ParsedArguments): void {
  const hasSubcommand = parsed.subcommand !== undefined;
  const hasTarget = parsed.target !== undefined;
  if (["init", "validate", "run", "doctor", "status", "help"].includes(parsed.command) && (hasSubcommand || hasTarget)) {
    throw new Error(`Unexpected argument for ${parsed.command}`);
  }
  if (parsed.command === "service" && (!hasSubcommand || hasTarget)) throw new Error("Expected exactly one service action");
  if (parsed.command === "inspect" && (parsed.subcommand !== "task" || !parsed.target)) {
    throw new Error("Usage: ensemble inspect task <task-id>");
  }
  if (parsed.journal && parsed.command !== "inspect") throw new Error("--journal is only valid with inspect task");
  if (parsed.repositoryId && parsed.command !== "inspect") throw new Error("--repository is only valid with inspect task");
  if (parsed.json && !["doctor", "status", "inspect"].includes(parsed.command)) {
    throw new Error("--json is only valid with doctor, status, or inspect task");
  }
}

async function initializeFiles(
  parsed: ParsedArguments,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await Promise.all([
    mkdir(dirname(parsed.configPath), { recursive: true, mode: 0o750 }),
    mkdir(parsed.paths.state, { recursive: true, mode: 0o700 }),
    mkdir(parsed.paths.workspaces, { recursive: true, mode: 0o700 }),
    ...(parsed.paths.logs ? [mkdir(parsed.paths.logs, { recursive: true, mode: 0o700 })] : []),
  ]);
  const git = await findExecutable("git", environment.PATH) ?? "/usr/bin/git";
  const codex = await findExecutable("codex", environment.PATH) ?? "/usr/local/bin/codex";
  await createExclusive(parsed.configPath, hostTemplate(parsed.paths, git, codex), platform === "linux" ? 0o640 : 0o600);
  await createExclusive(parsed.environmentPath, [
    "# Ensemble controller values; this file is not shell syntax.",
    "VIKUNJA_API_TOKEN=",
    `CODEX_HOME=${resolve(parsed.paths.state, "codex")}`,
    "",
  ].join("\n"), 0o600);
}

async function createExclusive(path: string, content: string, mode: number): Promise<void> {
  let handle;
  try { handle = await open(path, "wx", mode); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try { await handle.writeFile(content, "utf8"); }
  finally { await handle.close(); }
}

async function findExecutable(name: string, path: string | undefined): Promise<string | undefined> {
  for (const directory of (path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; }
    catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

function hostTemplate(paths: HostPaths, git: string, codex: string): string {
  return `version: 1
service:
  startupTimeoutMs: 30000
  stopTimeoutSeconds: 60
logging:
  level: info
workspace:
  root: ${yaml(paths.workspaces)}
  preserve: true
  gitExecutable: ${yaml(git)}
runtimes:
  - name: codex
    type: codex-app-server
    executable: ${yaml(codex)}
    serverArguments: [app-server, --listen, stdio://]
    requestTimeoutMs: 30000
    environment:
      inherit: [PATH, HOME, CODEX_HOME, TMPDIR, LANG, LC_ALL]
repositories:
  - id: ensemble
    url: https://example.invalid/replace-with-repository.git
    branch: main
    configurationPath: /absolute/path/to/configuration-checkout
    provider:
      type: vikunja
      baseUrl: https://vikunja.example.invalid
      token: $VIKUNJA_API_TOKEN
      projectId: 1
      viewId: 1
      requiredLabels: []
`;
}

function yaml(value: string): string { return JSON.stringify(value); }
function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_024 ? message : `${message.slice(0, 1_023)}…`;
}
function help(): string {
  return `Usage: ensemble <command> [options]

Commands:
  init                 Create host configuration and protected environment files
  validate             Validate host, provider, repository, and runtime configuration
  doctor               Run non-dispatching host and protocol diagnostics
  status               Show local controller and configured repository status
  inspect task <id>    Inspect durable task and execution state
  run                  Run the orchestration service in the foreground
  service install      Install the systemd or launchd service
  service uninstall    Remove the platform service
  service start        Start the platform service
  service stop         Stop the platform service
  service restart      Restart the platform service
  service status       Show supervisor state and configured paths
  service logs         Follow service logs

Options:
  --config <absolute path>
  --env-file <absolute path>
  --repository <id>    Select a repository when more than one is configured
  --journal            Include safe provider journal metadata during task inspection
  --json               Emit machine-readable JSON
`;
}

function selectRepository(controller: Awaited<ReturnType<typeof buildHostController>>, repositoryId?: string) {
  if (repositoryId) {
    const selected = controller.repositories.find((entry) => entry.provider.repository.id === repositoryId);
    if (!selected) throw new Error(`Unknown repository: ${repositoryId}`);
    return selected;
  }
  if (controller.repositories.length !== 1) throw new Error("--repository is required when multiple repositories are configured");
  return controller.repositories[0]!;
}

function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map((check) => `${check.status === "pass" ? "PASS" : check.status === "warning" ? "WARN" : "FAIL"} ${check.id}: ${check.detail}`);
  lines.push(report.healthy ? "Ensemble diagnostics passed" : "Ensemble diagnostics failed");
  return `${lines.join("\n")}\n`;
}

function formatStatus(report: HostStatusReport): string {
  const lines = [
    `Controller: ${report.controller.state}${report.controller.pid ? ` (PID ${report.controller.pid})` : ""}`,
    `Configuration: ${report.configurationPath}`,
    `State: ${report.statePath}`,
  ];
  if (report.workspacePath) lines.push(`Workspace: ${report.workspacePath}`);
  if (report.repositories) lines.push(`Repositories: ${report.repositories.join(", ")}`);
  if (report.runtimes) lines.push(`Runtimes: ${report.runtimes.join(", ")}`);
  if (report.configurationError) lines.push(`Configuration error: ${report.configurationError}`);
  return `${lines.join("\n")}\n`;
}

interface TaskDiagnosticProjection {
  readonly repositoryId: string;
  readonly provider: string;
  readonly task: Pick<ProviderTaskDiagnostic["task"], "id" | "title" | "status" | "dispatchable" | "labels" | "assignees" | "blockers">;
  readonly execution: ProviderTaskDiagnostic["execution"];
  readonly commentCount: number;
  readonly artifactCount: number;
  readonly journal?: ProviderTaskDiagnostic["journal"];
}

function taskDiagnosticProjection(repositoryId: string, provider: string, report: ProviderTaskDiagnostic): TaskDiagnosticProjection {
  const task = report.task;
  return Object.freeze({
    repositoryId,
    provider,
    task: Object.freeze({ id: task.id, title: boundedError(task.title), status: task.status,
      ...(task.dispatchable === undefined ? {} : { dispatchable: task.dispatchable }), labels: task.labels,
      assignees: task.assignees, ...(task.blockers ? { blockers: task.blockers } : {}) }),
    execution: report.execution,
    commentCount: report.commentCount,
    artifactCount: report.artifactCount,
    ...(report.journal ? { journal: report.journal } : {}),
  });
}

function formatTaskDiagnostic(report: TaskDiagnosticProjection): string {
  const active = report.execution.active;
  const lines = [
    `Task: ${report.task.id} — ${report.task.title}`,
    `Repository: ${report.repositoryId} (${report.provider})`,
    `Status: ${report.task.status}`,
    `Dispatchable: ${String(report.task.dispatchable ?? false)}`,
    `Comments: ${report.commentCount}`,
    `Artifacts: ${report.artifactCount}`,
    active ? `Active execution: ${active.id} (${active.role})` : "Active execution: none",
  ];
  if (active?.ownerId) lines.push(`Owner: ${active.ownerId}`);
  if (active?.leaseExpiresAt) lines.push(`Lease expires: ${active.leaseExpiresAt}`);
  lines.push(`History: ${report.execution.history.length} execution(s)`);
  for (const record of report.execution.history) lines.push(`  ${record.finishedAt} ${record.id} ${record.role} ${record.outcome}`);
  if (report.journal) {
    lines.push(`Journal: ${report.journal.length} event(s)`);
    for (const event of report.journal) lines.push(`  ${event.sequence}. ${event.createdAt} ${event.kind} ${event.executionId}`);
  }
  return `${lines.join("\n")}\n`;
}

export function isCliEntrypoint(argvPath: string | undefined, modulePath: string): boolean {
  if (!argvPath) return false;
  try { return realpathSync(argvPath) === realpathSync(modulePath); }
  catch { return false; }
}

if (isCliEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2));
}
