import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { VikunjaStatusLabels } from "../providers/vikunja/adapter.ts";
import type { OperationalLogLevel } from "../domain/observability.ts";
import { parseSimpleYaml } from "../execution/repository.ts";

export interface HostPaths {
  readonly configuration: string;
  readonly environment: string;
  readonly state: string;
  readonly workspaces: string;
  readonly logs?: string;
}

export interface HostServiceConfiguration {
  readonly startupTimeoutMs: number;
  readonly stopTimeoutSeconds: number;
}

export interface HostLoggingConfiguration {
  readonly level: OperationalLogLevel;
}

export interface HostWorkspaceConfiguration {
  readonly root: string;
  readonly preserve: boolean;
  readonly gitExecutable: string;
}

export interface HostRuntimeEnvironment {
  readonly inherit: readonly string[];
}

export interface HostCodexAppServerRuntimeConfiguration {
  readonly name: string;
  readonly type: "codex-app-server";
  readonly executable: string;
  readonly serverArguments: readonly string[];
  readonly requestTimeoutMs: number;
  readonly environment: HostRuntimeEnvironment;
}

export interface HostOpenCodeServerRuntimeConfiguration {
  readonly name: string;
  readonly type: "opencode-server";
  readonly executable: string;
  readonly serverArguments: readonly string[];
  readonly requestTimeoutMs: number;
  readonly environment: HostRuntimeEnvironment;
}

export type HostRuntimeConfiguration = HostCodexAppServerRuntimeConfiguration | HostOpenCodeServerRuntimeConfiguration;

export interface HostVikunjaConfiguration {
  readonly type: "vikunja";
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: number;
  readonly viewId: number;
  readonly requiredAssignee?: string;
  readonly requiredLabels: readonly string[];
  readonly statusLabels?: Partial<VikunjaStatusLabels>;
}

export interface HostRepositoryConfiguration {
  readonly id: string;
  readonly url: string;
  readonly branch?: string;
  readonly configurationPath: string;
  readonly provider: HostVikunjaConfiguration;
}

export interface HostConfiguration {
  readonly version: 1;
  readonly service: HostServiceConfiguration;
  readonly logging: HostLoggingConfiguration;
  readonly workspace: HostWorkspaceConfiguration;
  readonly runtimes: readonly HostRuntimeConfiguration[];
  readonly repositories: readonly HostRepositoryConfiguration[];
}

export interface EnvironmentFileValidationOptions {
  readonly platform?: NodeJS.Platform;
  readonly userId?: number;
  readonly groupIds?: readonly number[];
}

const MAX_ENVIRONMENT_BYTES = 65_536;
const MAX_ENVIRONMENT_VALUE_BYTES = 16_384;
const forbiddenRuntimeEnvironment = /(TOKEN|SECRET|PASSWORD|AUTHORIZATION|API_?KEY|VIKUNJA|AWS_|AZURE_|GOOGLE_)/u;

export function defaultHostPaths(platform: NodeJS.Platform = process.platform, home = homedir()): HostPaths {
  if (platform === "linux") {
    return Object.freeze({
      configuration: "/etc/ensemble/config.yaml",
      environment: "/etc/ensemble/ensemble.env",
      state: "/var/lib/ensemble",
      workspaces: "/var/lib/ensemble/workspaces",
    });
  }
  if (platform === "darwin") {
    const application = resolve(home, "Library", "Application Support", "Ensemble");
    return Object.freeze({
      configuration: resolve(application, "config.yaml"),
      environment: resolve(application, "ensemble.env"),
      state: resolve(application, "state"),
      workspaces: resolve(application, "workspaces"),
      logs: resolve(home, "Library", "Logs", "Ensemble"),
    });
  }
  const application = resolve(home, ".ensemble");
  return Object.freeze({
    configuration: resolve(application, "config.yaml"),
    environment: resolve(application, "ensemble.env"),
    state: resolve(application, "state"),
    workspaces: resolve(application, "workspaces"),
  });
}

export async function loadEnvironmentFile(
  path: string,
  options: EnvironmentFileValidationOptions = {},
): Promise<Readonly<Record<string, string>>> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Environment file must be a regular non-symlink: ${path}`);
  validateEnvironmentPermissions(path, details, options);
  if (details.size > MAX_ENVIRONMENT_BYTES) throw new Error(`Environment file exceeds ${MAX_ENVIRONMENT_BYTES} bytes: ${path}`);
  const source = await readFile(path, "utf8");
  if (source.includes("\0")) throw new Error(`Environment file contains a null byte: ${path}`);
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`Invalid environment record at ${path}:${index + 1}`);
    const name = match[1]!;
    const value = match[2]!;
    if (Object.hasOwn(environment, name)) throw new Error(`Duplicate environment variable ${name} at ${path}:${index + 1}`);
    if (Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new Error(`Environment value exceeds ${MAX_ENVIRONMENT_VALUE_BYTES} bytes: ${name}`);
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
}

export async function loadHostConfiguration(path: string): Promise<HostConfiguration> {
  if (!isAbsolute(path)) throw new Error(`Host configuration path must be absolute: ${path}`);
  const source = await readFile(path, "utf8");
  return parseHostConfiguration(source);
}

export function parseHostConfiguration(source: string): HostConfiguration {
  const root = parseSimpleYaml(source);
  exactKeys(root, ["version", "service", "logging", "workspace", "runtimes", "repositories"], "host");
  const version = integer(root.version, "version", 1);
  if (version !== 1) throw new Error(`Unsupported host configuration version: ${version}`);
  const service = mapping(root.service, "service", true);
  exactKeys(service, ["startupTimeoutMs", "stopTimeoutSeconds"], "service");
  const logging = mapping(root.logging, "logging", false);
  exactKeys(logging, ["level"], "logging");
  const workspace = mapping(root.workspace, "workspace", true);
  exactKeys(workspace, ["root", "preserve", "gitExecutable"], "workspace");
  const workspaceRoot = absolutePath(workspace.root, "workspace.root");
  const gitExecutable = absolutePath(workspace.gitExecutable, "workspace.gitExecutable");
  const runtimes = list(root.runtimes, "runtimes").map((value, index) => runtimeAt(value, `runtimes[${index}]`));
  const runtimeNames = unique(runtimes.map((runtime) => runtime.name), "runtime name");
  if (runtimeNames.size !== runtimes.length) throw new Error("Runtime names must be unique");
  const repositories = list(root.repositories, "repositories").map((value, index) => repositoryAt(value, `repositories[${index}]`));
  if (repositories.length === 0) throw new Error("At least one repository registration is required");
  const repositoryIds = unique(repositories.map((repository) => repository.id), "repository ID");
  if (repositoryIds.size !== repositories.length) throw new Error("Repository IDs must be unique");
  return deepFreeze({
    version: 1,
    service: {
      startupTimeoutMs: nonNegativeInteger(service.startupTimeoutMs, "service.startupTimeoutMs", 30_000),
      stopTimeoutSeconds: positiveInteger(service.stopTimeoutSeconds ?? 60, "service.stopTimeoutSeconds"),
    },
    logging: { level: loggingLevel(logging.level) },
    workspace: {
      root: workspaceRoot,
      preserve: booleanValue(workspace.preserve, "workspace.preserve", true),
      gitExecutable,
    },
    runtimes,
    repositories,
  });
}

export function runtimeEnvironment(
  inherited: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of inherited) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new Error(`Invalid runtime environment variable name: ${name}`);
    if (forbiddenRuntimeEnvironment.test(name)) throw new Error(`Forbidden runtime environment variable: ${name}`);
    const value = environment[name];
    if (value !== undefined) selected[name] = value;
  }
  return Object.freeze(selected);
}

function runtimeAt(value: unknown, path: string): HostRuntimeConfiguration {
  const runtime = mapping(value, path, true);
  const type = text(runtime.type, `${path}.type`);
  if (type !== "codex-app-server" && type !== "opencode-server") {
    throw new Error(`Unsupported runtime type at ${path}.type: ${type}`);
  }
  exactKeys(runtime, ["name", "type", "executable", "serverArguments", "requestTimeoutMs", "environment"], path);
  const environment = mapping(runtime.environment, `${path}.environment`, false);
  exactKeys(environment, ["inherit"], `${path}.environment`);
  const inherit = stringList(environment.inherit, `${path}.environment.inherit`, [
    "PATH", "HOME", ...(type === "codex-app-server" ? ["CODEX_HOME"] : ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]),
    "TMPDIR", "LANG", "LC_ALL",
  ]);
  for (const name of inherit) {
    if (forbiddenRuntimeEnvironment.test(name)) throw new Error(`Forbidden runtime environment variable: ${name}`);
  }
  const shared = {
    name: text(runtime.name, `${path}.name`),
    executable: absolutePath(runtime.executable, `${path}.executable`),
    environment: { inherit },
  };
  return { ...shared, type,
    serverArguments: stringList(runtime.serverArguments, `${path}.serverArguments`,
      type === "codex-app-server" ? ["app-server", "--listen", "stdio://"] : ["serve", "--pure"]),
    requestTimeoutMs: positiveInteger(runtime.requestTimeoutMs ?? 30_000, `${path}.requestTimeoutMs`),
  };
}

function repositoryAt(value: unknown, path: string): HostRepositoryConfiguration {
  const repository = mapping(value, path, true);
  exactKeys(repository, ["id", "url", "branch", "configurationPath", "provider"], path);
  const provider = mapping(repository.provider, `${path}.provider`, true);
  exactKeys(provider, ["type", "baseUrl", "token", "projectId", "viewId", "requiredAssignee", "requiredLabels", "statusLabels"], `${path}.provider`);
  const type = text(provider.type, `${path}.provider.type`);
  if (type !== "vikunja") throw new Error(`Unsupported provider type at ${path}.provider.type: ${type}`);
  const statusLabels = provider.statusLabels === undefined
    ? undefined
    : statusLabelsAt(provider.statusLabels, `${path}.provider.statusLabels`);
  return {
    id: text(repository.id, `${path}.id`),
    url: url(repository.url, `${path}.url`),
    ...(repository.branch === undefined ? {} : { branch: text(repository.branch, `${path}.branch`) }),
    configurationPath: absolutePath(repository.configurationPath, `${path}.configurationPath`),
    provider: {
      type,
      baseUrl: url(provider.baseUrl, `${path}.provider.baseUrl`),
      token: secretReference(provider.token, `${path}.provider.token`),
      projectId: positiveInteger(provider.projectId, `${path}.provider.projectId`),
      viewId: positiveInteger(provider.viewId, `${path}.provider.viewId`),
      ...(provider.requiredAssignee === undefined ? {} : { requiredAssignee: text(provider.requiredAssignee, `${path}.provider.requiredAssignee`) }),
      requiredLabels: stringList(provider.requiredLabels, `${path}.provider.requiredLabels`, []),
      ...(statusLabels ? { statusLabels } : {}),
    },
  };
}

function statusLabelsAt(value: unknown, path: string): Partial<VikunjaStatusLabels> {
  const labels = mapping(value, path, true);
  exactKeys(labels, ["ready", "running", "blocked", "failed", "completed"], path);
  return Object.fromEntries(Object.entries(labels).map(([key, child]) => [key, text(child, `${path}.${key}`)]));
}

function validateEnvironmentPermissions(
  path: string,
  details: Stats,
  options: EnvironmentFileValidationOptions,
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return;
  const currentUser = options.userId ?? process.getuid?.();
  const groups = new Set(options.groupIds ?? process.getgroups?.() ?? []);
  const mode = details.mode & 0o777;
  if (platform === "darwin") {
    if (currentUser !== undefined && details.uid === currentUser && mode === 0o600) return;
    throw new Error(`Environment file permissions require current-user ownership and mode 0600: ${path}`);
  }
  if (currentUser !== undefined && details.uid === currentUser && mode === 0o600) return;
  if (details.uid === 0 && mode === 0o640 && (currentUser === 0 || groups.has(details.gid))) return;
  throw new Error(`Environment file permissions require service-owned mode 0600 or root-owned mode 0640: ${path}`);
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new Error(`Unknown host configuration key: ${path}.${key}`);
}

function mapping(value: unknown, path: string, required: boolean): Record<string, unknown> {
  if (value === undefined && !required) return Object.create(null) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected mapping: ${path}`);
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected list: ${path}`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Expected non-empty string: ${path}`);
  return value;
}

function url(value: unknown, path: string): string {
  const source = text(value, path);
  try { return new URL(source).toString(); }
  catch { throw new Error(`Expected absolute URL: ${path}`); }
}

function absolutePath(value: unknown, path: string): string {
  const source = text(value, path);
  if (!isAbsolute(source)) throw new Error(`Expected absolute path: ${path}`);
  return resolve(source);
}

function secretReference(value: unknown, path: string): string {
  const source = text(value, path);
  if (!/^\$[A-Z_][A-Z0-9_]*$/u.test(source)) throw new Error(`Expected environment secret reference: ${path}`);
  return source;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Expected positive safe integer: ${path}`);
  return value as number;
}

function loggingLevel(value: unknown): OperationalLogLevel {
  if (value === undefined) return "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("Expected logging.level to be debug, info, warn, or error");
}

function nonNegativeInteger(value: unknown, path: string, fallback: number): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || (selected as number) < 0) throw new Error(`Expected non-negative safe integer: ${path}`);
  return selected as number;
}

function integer(value: unknown, path: string, fallback: number): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected)) throw new Error(`Expected safe integer: ${path}`);
  return selected as number;
}

function booleanValue(value: unknown, path: string, fallback: boolean): boolean {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "boolean") throw new Error(`Expected boolean: ${path}`);
  return selected;
}

function stringList(value: unknown, path: string, fallback: readonly string[]): readonly string[] {
  const selected = value === undefined ? fallback : value;
  if (!Array.isArray(selected) || selected.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Expected non-empty string list: ${path}`);
  }
  return Object.freeze([...selected] as string[]);
}

function unique(values: readonly string[], name: string): ReadonlySet<string> {
  for (const value of values) if (!value.trim()) throw new Error(`Expected non-empty ${name}`);
  return new Set(values);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
