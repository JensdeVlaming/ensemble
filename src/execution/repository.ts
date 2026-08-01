import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isScalar, parseAllDocuments, visit } from "yaml";
import type {
  FailureKind,
  RepositoryConfiguration,
  RepositoryRef,
  RoleDefinition,
  Task,
  WorkspaceHook,
  WorkspaceHooks,
} from "../domain/model.ts";

export interface LoadedRepositoryConfiguration {
  readonly revision: string;
  readonly configuration: RepositoryConfiguration;
}

export interface RepositoryConfigSource {
  load(repository: RepositoryRef, repositoryPath: string): Promise<RepositoryConfiguration>;
  loadRevision?(repository: RepositoryRef, repositoryPath: string): Promise<LoadedRepositoryConfiguration>;
}

export interface ConfigurationResolver {
  resolve(task: Task): Promise<RepositoryConfiguration>;
}

export type ConfigurationReloadStatus = "installed" | "unchanged" | "retained";

export interface ConfigurationReloadResult {
  readonly status: ConfigurationReloadStatus;
  readonly revision: string;
  readonly configuration: RepositoryConfiguration;
  readonly diagnostic?: string;
}

export interface ReloadableConfigurationResolver extends ConfigurationResolver {
  reload(validate?: (configuration: RepositoryConfiguration) => void): Promise<ConfigurationReloadResult>;
}

export interface RepositoryRevisionReader {
  read(path: string): Promise<string>;
  list(path: string): Promise<readonly string[]>;
}

export interface RepositoryConfigurationManagerOptions {
  readonly redact?: (message: string) => string;
  readonly maxDiagnosticLength?: number;
}

export class ConfigurationReloadError extends Error {
  readonly diagnostic: string;

  constructor(diagnostic: string) {
    super(diagnostic);
    this.name = "ConfigurationReloadError";
    this.diagnostic = diagnostic;
  }
}

export class HostSecretResolver {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #values = new Set<string>();

  constructor(environment: Readonly<Record<string, string | undefined>> = process.env) {
    this.#environment = environment;
  }

  resolve(reference: string, path: string): string {
    const match = /^\$([A-Z_][A-Z0-9_]*)$/u.exec(reference);
    if (!match) throw new Error(`Expected an environment secret reference at ${path}`);
    const name = match[1]!;
    const value = this.#environment[name];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`Missing or empty environment secret ${name} at ${path}`);
    }
    this.#values.add(value);
    return value;
  }

  redact(message: string): string {
    let redacted = message;
    for (const value of [...this.#values].sort((left, right) => right.length - left.length)) {
      redacted = redacted.replaceAll(value, "[REDACTED]");
    }
    return redacted;
  }
}

export class RepositoryConfigurationManager implements ReloadableConfigurationResolver {
  readonly source: RepositoryConfigSource;
  readonly repository: RepositoryRef;
  readonly repositoryPath: string;
  readonly #redact: (message: string) => string;
  readonly #maxDiagnosticLength: number;
  #current?: LoadedRepositoryConfiguration;
  #reloading?: Promise<ConfigurationReloadResult>;

  constructor(
    source: RepositoryConfigSource,
    repository: RepositoryRef,
    repositoryPath: string,
    options: RepositoryConfigurationManagerOptions = {},
  ) {
    if (!repository.id.trim()) throw new Error("Repository ID is required for configuration reload");
    if (!repositoryPath.trim()) throw new Error("Repository configuration path is required");
    const maximum = options.maxDiagnosticLength ?? 1_024;
    if (!Number.isSafeInteger(maximum) || maximum < 32) {
      throw new Error("Configuration diagnostic length must be a safe integer of at least 32");
    }
    this.source = source;
    this.repository = Object.freeze({ ...repository });
    this.repositoryPath = repositoryPath;
    this.#redact = options.redact ?? ((message) => message);
    this.#maxDiagnosticLength = maximum;
  }

  reload(validate?: (configuration: RepositoryConfiguration) => void): Promise<ConfigurationReloadResult> {
    if (this.#reloading) return this.#reloading;
    const reloading = this.#performReload(validate);
    this.#reloading = reloading;
    void reloading.finally(() => {
      if (this.#reloading === reloading) this.#reloading = undefined;
    }).catch(() => undefined);
    return reloading;
  }

  async resolve(task: Task): Promise<RepositoryConfiguration> {
    if (task.repository.id !== this.repository.id || task.repository.url !== this.repository.url) {
      throw new Error(`Configuration manager does not own repository ${task.repository.id}`);
    }
    if (!this.#current) throw new ConfigurationReloadError("Repository has no valid configuration revision");
    return this.#current.configuration;
  }

  async #performReload(validate?: (configuration: RepositoryConfiguration) => void): Promise<ConfigurationReloadResult> {
    try {
      const loaded = this.source.loadRevision
        ? await this.source.loadRevision(this.repository, this.repositoryPath)
        : await loadWithoutRevision(this.source, this.repository, this.repositoryPath);
      if (typeof loaded.revision !== "string" || loaded.revision.trim().length === 0) {
        throw new Error("Configuration source returned an invalid revision identifier");
      }
      const configuration = deepFreeze(loaded.configuration);
      if (configuration.repository.id !== this.repository.id || configuration.repository.url !== this.repository.url) {
        throw new Error("Configuration source returned a different repository");
      }
      validate?.(configuration);
      if (this.#current?.revision === loaded.revision) {
        return Object.freeze({
          status: "unchanged" as const,
          revision: this.#current.revision,
          configuration: this.#current.configuration,
        });
      }
      this.#current = Object.freeze({ revision: loaded.revision, configuration });
      return Object.freeze({ status: "installed" as const, revision: loaded.revision, configuration });
    } catch (error) {
      const diagnostic = this.#safeDiagnostic(error);
      if (!this.#current) throw new ConfigurationReloadError(diagnostic);
      return Object.freeze({
        status: "retained" as const,
        revision: this.#current.revision,
        configuration: this.#current.configuration,
        diagnostic,
      });
    }
  }

  #safeDiagnostic(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    let redacted: string;
    try {
      redacted = this.#redact(raw);
    } catch {
      redacted = "Configuration reload failed during diagnostic redaction";
    }
    if (redacted.length <= this.#maxDiagnosticLength) return redacted;
    return `${redacted.slice(0, this.#maxDiagnosticLength - 1)}…`;
  }
}

type ConfigObject = Record<string, unknown>;

const MAX_YAML_ALIASES = 100;
const DEFAULT_SNAPSHOT_READS = 3;
const unsafeConfigKeys = new Set(["__proto__", "constructor", "prototype", "<<"]);

const nodeRevisionReader: RepositoryRevisionReader = {
  read: (path) => readFile(path, "utf8"),
  list: (path) => readdir(path),
};

const retryableFailureKinds = ["startup", "provider", "runtime", "timeout", "stalled"] as const satisfies readonly FailureKind[];
const failureKinds = new Set<FailureKind>([
  "startup", "provider", "configuration", "runtime", "timeout", "stalled", "reconciliation", "shutdown",
]);

export class RepositoryConfigLoader implements RepositoryConfigSource {
  readonly #reader: RepositoryRevisionReader;
  readonly #snapshotReads: number;

  constructor(reader: RepositoryRevisionReader = nodeRevisionReader, snapshotReads = DEFAULT_SNAPSHOT_READS) {
    if (!Number.isSafeInteger(snapshotReads) || snapshotReads < 2) {
      throw new Error("Repository revision capture requires at least two snapshot reads");
    }
    this.#reader = reader;
    this.#snapshotReads = snapshotReads;
  }

  async load(repository: RepositoryRef, repositoryPath: string): Promise<RepositoryConfiguration> {
    return (await this.loadRevision(repository, repositoryPath)).configuration;
  }

  async loadRevision(repository: RepositoryRef, repositoryPath: string): Promise<LoadedRepositoryConfiguration> {
    const snapshot = await this.#stableSnapshot(repositoryPath);
    const configuration = parseRepositorySnapshot(repository, snapshot);
    return Object.freeze({ revision: snapshotRevision(snapshot), configuration: deepFreeze(configuration) });
  }

  async #stableSnapshot(repositoryPath: string): Promise<RepositorySnapshot> {
    let previous: RepositorySnapshot | undefined;
    let lastReadError: unknown;
    for (let read = 0; read < this.#snapshotReads; read += 1) {
      try {
        const current = await this.#snapshot(repositoryPath);
        if (previous && snapshotsEqual(previous, current)) return current;
        previous = current;
        lastReadError = undefined;
      } catch (error) {
        previous = undefined;
        lastReadError = error;
      }
    }
    if (lastReadError !== undefined && previous === undefined) {
      const detail = lastReadError instanceof Error ? lastReadError.message : String(lastReadError);
      throw new Error(`Unable to capture repository configuration after ${this.#snapshotReads} reads: ${detail}`);
    }
    throw new Error(`Repository configuration changed during ${this.#snapshotReads} consecutive snapshot reads`);
  }

  async #snapshot(repositoryPath: string): Promise<RepositorySnapshot> {
    const ensemblePath = join(repositoryPath, ".ensemble");
    const roleNames = [...await this.#reader.list(join(ensemblePath, "roles"))]
      .filter((name) => name.endsWith(".md"))
      .sort();
    const paths = [
      ".ensemble/config.yaml",
      ".ensemble/WORKFLOW.md",
      "AGENTS.md",
      ...roleNames.map((name) => `.ensemble/roles/${name}`),
    ];
    const contents = await Promise.all([
      this.#reader.read(join(ensemblePath, "config.yaml")),
      this.#reader.read(join(ensemblePath, "WORKFLOW.md")),
      this.#reader.read(join(repositoryPath, "AGENTS.md")),
      ...roleNames.map((name) => this.#reader.read(join(ensemblePath, "roles", name))),
    ]);
    return Object.freeze({
      members: Object.freeze(paths.map((path, index) => Object.freeze({ path, content: contents[index]! }))),
    });
  }
}

interface RepositorySnapshotMember {
  readonly path: string;
  readonly content: string;
}

interface RepositorySnapshot {
  readonly members: readonly RepositorySnapshotMember[];
}

function parseRepositorySnapshot(repository: RepositoryRef, snapshot: RepositorySnapshot): RepositoryConfiguration {
    const byPath = new Map(snapshot.members.map((member) => [member.path, member.content]));
    const rawConfig = requiredMember(byPath, ".ensemble/config.yaml");
    const workflow = requiredMember(byPath, ".ensemble/WORKFLOW.md");
    const agents = requiredMember(byPath, "AGENTS.md");
    const roles = snapshot.members
      .filter((member) => member.path.startsWith(".ensemble/roles/") && member.path.endsWith(".md"))
      .map((member): RoleDefinition => ({
        name: member.path.slice(".ensemble/roles/".length, -3),
        instructions: member.content,
      }));
    if (roles.length === 0) throw new Error("At least one .ensemble role is required");
    const config = parseSimpleYaml(rawConfig);

    const runtime = objectAt(config, "runtime");
    const statuses = objectAt(config, "statuses", false);
    const service = objectAt(config, "service", false);
    const concurrency = objectAt(config, "concurrency", false);
    const byStatus = objectAt(concurrency, "byStatus", false);
    const retry = objectAt(config, "retry", false);
    const timeouts = objectAt(config, "timeouts", false);
    const shutdown = objectAt(config, "shutdown", false);
    const workspace = objectAt(config, "workspace", false);
    const hooks = objectAt(workspace, "hooks", false);
    const initialRole = stringAt(config, "initialRole", roles[0]!.name);
    if (!roles.some((role) => role.name === initialRole)) {
      throw new Error(`Initial role does not exist: ${initialRole}`);
    }

    return {
      repository,
      workflow: { instructions: workflow, roles },
      agents,
      runtime: {
        name: stringAt(runtime, "name"),
        config: { ...objectAt(runtime, "config", false) },
      },
      initialRole,
      terminalOutcomes: stringListAt(config, "terminalOutcomes", ["approved", "completed"]),
      runnableStatuses: stringListAt(statuses, "runnable", ["todo", "in_progress"]),
      runningStatus: stringAt(statuses, "running", "in_progress"),
      completedStatus: stringAt(statuses, "completed", "done"),
      failedStatus: stringAt(statuses, "failed", "failed"),
      blockedStatus: stringAt(statuses, "blocked", "blocked"),
      service: {
        pollIntervalMs: nonNegativeIntegerAt(service, "pollIntervalMs", 30_000, "service.pollIntervalMs"),
      },
      concurrency: {
        global: capacityAt(concurrency, "global", 10, "concurrency.global"),
        byStatus: capacitiesAt(byStatus, "concurrency.byStatus"),
      },
      retry: {
        maxFailedAttemptsPerRole: nonNegativeIntegerAt(retry, "maxFailedAttemptsPerRole", 3, "retry.maxFailedAttemptsPerRole"),
        initialDelayMs: nonNegativeIntegerAt(retry, "initialDelayMs", 1_000, "retry.initialDelayMs"),
        maxDelayMs: nonNegativeIntegerAt(retry, "maxDelayMs", 300_000, "retry.maxDelayMs"),
        multiplier: finiteNumberAt(retry, "multiplier", 2, "retry.multiplier", 1),
        jitterRatio: finiteNumberAt(retry, "jitterRatio", 0.2, "retry.jitterRatio", 0, 1),
        retryableFailureKinds: failureKindListAt(retry, "retryableFailureKinds", retryableFailureKinds),
      },
      timeouts: {
        startupMs: nonNegativeIntegerAt(timeouts, "startupMs", 30_000, "timeouts.startupMs"),
        providerMs: nonNegativeIntegerAt(timeouts, "providerMs", 30_000, "timeouts.providerMs"),
        runtimeStartMs: nonNegativeIntegerAt(timeouts, "runtimeStartMs", 30_000, "timeouts.runtimeStartMs"),
        turnMs: nonNegativeIntegerAt(timeouts, "turnMs", 3_600_000, "timeouts.turnMs"),
        stallMs: nonNegativeIntegerAt(timeouts, "stallMs", 300_000, "timeouts.stallMs"),
        cancellationMs: nonNegativeIntegerAt(timeouts, "cancellationMs", 10_000, "timeouts.cancellationMs"),
      },
      shutdown: {
        drainTimeoutMs: nonNegativeIntegerAt(shutdown, "drainTimeoutMs", 30_000, "shutdown.drainTimeoutMs"),
      },
      workspace: {
        hooks: hooksAt(hooks),
        hookTimeoutMs: nonNegativeIntegerAt(workspace, "hookTimeoutMs", 60_000, "workspace.hookTimeoutMs"),
      },
    };
}

function requiredMember(members: ReadonlyMap<string, string>, path: string): string {
  const content = members.get(path);
  if (content === undefined) throw new Error(`Missing repository configuration member: ${path}`);
  return content;
}

function snapshotsEqual(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  return left.members.length === right.members.length
    && left.members.every((member, index) => member.path === right.members[index]?.path
      && member.content === right.members[index]?.content);
}

function snapshotRevision(snapshot: RepositorySnapshot): string {
  const hash = createHash("sha256");
  for (const member of snapshot.members) {
    hash.update(String(Buffer.byteLength(member.path)));
    hash.update(":");
    hash.update(member.path);
    hash.update(String(Buffer.byteLength(member.content)));
    hash.update(":");
    hash.update(member.content);
  }
  return hash.digest("hex");
}

async function loadWithoutRevision(
  source: RepositoryConfigSource,
  repository: RepositoryRef,
  repositoryPath: string,
): Promise<LoadedRepositoryConfiguration> {
  const configuration = await source.load(repository, repositoryPath);
  const revision = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  return { revision, configuration };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function nonNegativeIntegerAt(value: ConfigObject, key: string, fallback: number, path = key): number {
  const child = value[key] === undefined ? fallback : value[key];
  if (!Number.isSafeInteger(child) || (child as number) < 0) {
    throw new Error(`Expected non-negative integer within the safe range: ${path}`);
  }
  return child as number;
}

function capacityAt(value: ConfigObject, key: string, fallback: number, path: string): number {
  return nonNegativeIntegerAt(value, key, fallback, path);
}

function capacitiesAt(value: ConfigObject, path: string): Readonly<Record<string, number>> {
  const capacities: Record<string, number> = {};
  for (const [status, capacity] of Object.entries(value)) {
    if (!status.trim()) throw new Error(`Expected non-empty status name: ${path}`);
    if (!Number.isSafeInteger(capacity) || (capacity as number) < 0) {
      throw new Error(`Expected disabled zero or positive safe integer capacity: ${path}.${status}`);
    }
    capacities[status] = capacity as number;
  }
  return capacities;
}

function finiteNumberAt(
  value: ConfigObject,
  key: string,
  fallback: number,
  path: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const child = value[key] === undefined ? fallback : value[key];
  if (typeof child !== "number" || !Number.isFinite(child) || child < minimum || child > maximum) {
    throw new Error(`Expected finite number in [${minimum}, ${maximum}]: ${path}`);
  }
  return child;
}

function failureKindListAt(value: ConfigObject, key: string, fallback: readonly FailureKind[]): readonly FailureKind[] {
  const child = value[key] === undefined ? fallback : value[key];
  if (!Array.isArray(child) || child.some((item) => typeof item !== "string" || !failureKinds.has(item as FailureKind))) {
    throw new Error(`Expected failure kind list: retry.${key}`);
  }
  return [...child] as FailureKind[];
}

function hooksAt(value: ConfigObject): WorkspaceHooks {
  const afterCreate = hookAt(value, "afterCreate");
  const beforeRun = hookAt(value, "beforeRun");
  const afterRun = hookAt(value, "afterRun");
  const beforeRemove = hookAt(value, "beforeRemove");
  return {
    ...(afterCreate ? { afterCreate } : {}),
    ...(beforeRun ? { beforeRun } : {}),
    ...(afterRun ? { afterRun } : {}),
    ...(beforeRemove ? { beforeRemove } : {}),
  };
}

function hookAt(value: ConfigObject, key: string): WorkspaceHook | undefined {
  if (value[key] === undefined) return undefined;
  const hook = objectAt(value, key);
  const executable = stringAt(hook, "executable");
  const args = stringListAt(hook, "args");
  return { executable, args };
}

export function parseSimpleYaml(source: string): ConfigObject {
  const documents = parseAllDocuments(source, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    merge: false,
    resolveKnownTags: false,
    logLevel: "silent",
  });
  if (documents.length !== 1) throw new Error("Expected one YAML document in config.yaml");
  const document = documents[0]!;
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw new Error(`Invalid config.yaml: ${issue.message.split("\n", 1)[0]}`);
  if (document.directives?.yaml.explicit || /^%(?:YAML|TAG)\b/mu.test(source)) {
    throw new Error("Unsupported YAML directive in config.yaml");
  }
  visit(document, {
    Node: (_key, node) => {
      if (node.tag !== undefined) throw new Error("Unsupported YAML tag in config.yaml");
    },
    Pair: (_key, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error("Expected string YAML mapping key in config.yaml");
      }
    },
  });
  const value: unknown = document.toJS({ mapAsMap: false, maxAliasCount: MAX_YAML_ALIASES });
  const copied = copyConfigValue(value, "config.yaml", new WeakSet());
  if (!isConfigObject(copied)) throw new Error("Expected mapping root: config.yaml");
  return copied;
}

function copyConfigValue(value: unknown, path: string, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Expected finite YAML number: ${path}`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`Unsupported YAML value: ${path}`);
  if (ancestors.has(value)) throw new Error(`Cyclic YAML alias: ${path}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => copyConfigValue(item, `${path}[${index}]`, ancestors));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`Unsupported YAML object: ${path}`);
    const copied: ConfigObject = Object.create(null) as ConfigObject;
    for (const [key, child] of Object.entries(value)) {
      if (unsafeConfigKeys.has(key)) throw new Error(`Unsafe YAML key: ${path}.${key}`);
      copied[key] = copyConfigValue(child, `${path}.${key}`, ancestors);
    }
    return copied;
  } finally {
    ancestors.delete(value);
  }
}

function isConfigObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value: ConfigObject, key: string, required = true): ConfigObject {
  const child = value[key];
  if (child === undefined && !required) return {};
  if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error(`Expected mapping: ${key}`);
  return child as ConfigObject;
}

function stringAt(value: ConfigObject, key: string, fallback?: string): string {
  const child = value[key] === undefined ? fallback : value[key];
  if (typeof child !== "string" || child.trim().length === 0) throw new Error(`Expected non-empty string: ${key}`);
  return child;
}

function stringListAt(value: ConfigObject, key: string, fallback?: readonly string[]): readonly string[] {
  const child = value[key] === undefined ? fallback : value[key];
  if (!Array.isArray(child) || child.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Expected non-empty string list: ${key}`);
  }
  return [...child] as string[];
}
