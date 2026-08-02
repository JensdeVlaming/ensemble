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
    if (parsed.command === "help") { io.stdout.write(help()); return 0; }
    if (parsed.command === "init") {
      await initializeFiles(parsed, platform, context.environment ?? process.env);
      io.stdout.write(`Initialized Ensemble configuration at ${parsed.configPath}\n`);
      return 0;
    }
    if (parsed.command === "service") {
      return await serviceCommand(parsed, { ...context, platform, home, io });
    }
    if (parsed.command !== "validate" && parsed.command !== "run") throw new Error(`Unknown command: ${parsed.command}`);
    const fileEnvironment = await loadEnvironmentFile(parsed.environmentPath, {
      platform,
      ...(context.userId === undefined ? {} : { userId: context.userId }),
      ...(context.groupIds === undefined ? {} : { groupIds: context.groupIds }),
    });
    // The protected file is authoritative for explicitly configured controller values.
    const environment = Object.freeze({ ...(context.environment ?? process.env), ...fileEnvironment });
    const configuration = await loadHostConfiguration(parsed.configPath);
    if (parsed.command === "run") await initializeHostDirectories(configuration, parsed.paths.state);
    await validateHostFilesystem(configuration);
    const controller = await buildHostController(configuration, { environment, writable: io.stdout });
    if (parsed.command === "validate") {
      await controller.validate();
      io.stdout.write("Ensemble configuration is valid\n");
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
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--config" || argument === "--env-file") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (!value.startsWith("/")) throw new Error(`${argument} requires an absolute path`);
      if (argument === "--config") configPath = resolve(value);
      else environmentPath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { command: "help", configPath, environmentPath, paths: defaults };
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positionals.push(argument);
  }
  return {
    command: positionals[0] ?? "help",
    ...(positionals[1] ? { subcommand: positionals[1] } : {}),
    configPath,
    environmentPath,
    paths: defaults,
  };
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
`;
}

export function isCliEntrypoint(argvPath: string | undefined, modulePath: string): boolean {
  if (!argvPath) return false;
  try { return realpathSync(argvPath) === realpathSync(modulePath); }
  catch { return false; }
}

if (isCliEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2));
}
