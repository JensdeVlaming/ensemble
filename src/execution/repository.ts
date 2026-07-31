import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FailureKind,
  RepositoryConfiguration,
  RepositoryRef,
  RoleDefinition,
  WorkspaceHook,
  WorkspaceHooks,
} from "../domain/model.ts";

export interface RepositoryConfigSource {
  load(repository: RepositoryRef, repositoryPath: string): Promise<RepositoryConfiguration>;
}

type ConfigObject = Record<string, unknown>;

const retryableFailureKinds = ["startup", "provider", "runtime", "timeout", "stalled"] as const satisfies readonly FailureKind[];
const failureKinds = new Set<FailureKind>([
  "startup", "provider", "configuration", "runtime", "timeout", "stalled", "reconciliation", "shutdown",
]);

export class RepositoryConfigLoader implements RepositoryConfigSource {
  async load(repository: RepositoryRef, repositoryPath: string): Promise<RepositoryConfiguration> {
    const ensemblePath = join(repositoryPath, ".ensemble");
    const [rawConfig, workflow, agents, roleNames] = await Promise.all([
      readFile(join(ensemblePath, "config.yaml"), "utf8"),
      readFile(join(ensemblePath, "WORKFLOW.md"), "utf8"),
      readFile(join(repositoryPath, "AGENTS.md"), "utf8"),
      readdir(join(ensemblePath, "roles")),
    ]);
    const config = parseSimpleYaml(rawConfig);
    const roles = await Promise.all(
      roleNames
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map(async (file): Promise<RoleDefinition> => ({
          name: file.slice(0, -3),
          instructions: await readFile(join(ensemblePath, "roles", file), "utf8"),
        })),
    );
    if (roles.length === 0) throw new Error("At least one .ensemble role is required");

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

// Deliberately small YAML subset for repository configuration: mappings, scalar
// values, and inline lists. It rejects ambiguous input rather than guessing.
export function parseSimpleYaml(source: string): ConfigObject {
  const root: ConfigObject = {};
  const stack: Array<{ indent: number; value: ConfigObject }> = [{ indent: -1, value: root }];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const withoutComment = raw.replace(/\s+#.*$/u, "");
    if (!withoutComment.trim()) continue;
    if (/\t/u.test(raw)) throw new Error(`Tabs are not allowed in config.yaml (line ${index + 1})`);
    const indent = withoutComment.length - withoutComment.trimStart().length;
    const match = withoutComment.trim().match(/^([A-Za-z][\w-]*):(?:\s+(.*))?$/u);
    if (!match) throw new Error(`Unsupported YAML on line ${index + 1}`);
    while (stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)?.value;
    if (!parent) throw new Error(`Invalid indentation on line ${index + 1}`);
    const key = match[1]!;
    const encoded = match[2];
    if (encoded === undefined) {
      const child: ConfigObject = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(encoded.trim());
    }
  }
  return root;
}

function parseScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    return body ? body.split(",").map((item) => parseScalar(item.trim())) : [];
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
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
