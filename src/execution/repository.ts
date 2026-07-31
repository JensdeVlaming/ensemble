import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  RepositoryConfiguration,
  RepositoryRef,
  RoleDefinition,
} from "../domain/model.ts";

export interface RepositoryConfigSource {
  load(repository: RepositoryRef, repositoryPath: string): Promise<RepositoryConfiguration>;
}

type ConfigObject = Record<string, unknown>;

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
    const retry = objectAt(config, "retry", false);
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
        config: objectAt(runtime, "config", false),
      },
      initialRole,
      terminalOutcomes: stringListAt(config, "terminalOutcomes", ["approved", "completed"]),
      runnableStatuses: stringListAt(statuses, "runnable", ["todo", "in_progress"]),
      runningStatus: stringAt(statuses, "running", "in_progress"),
      completedStatus: stringAt(statuses, "completed", "done"),
      failedStatus: stringAt(statuses, "failed", "failed"),
      retry: { maxFailedAttemptsPerRole: nonNegativeIntegerAt(retry, "maxFailedAttemptsPerRole", 3) },
    };
  }
}

function nonNegativeIntegerAt(value: ConfigObject, key: string, fallback: number): number {
  const child = value[key] ?? fallback;
  if (!Number.isInteger(child) || (child as number) < 0) throw new Error(`Expected non-negative integer: ${key}`);
  return child as number;
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
  const child = value[key] ?? fallback;
  if (typeof child !== "string" || child.length === 0) throw new Error(`Expected string: ${key}`);
  return child;
}

function stringListAt(value: ConfigObject, key: string, fallback: readonly string[]): readonly string[] {
  const child = value[key] ?? fallback;
  if (!Array.isArray(child) || child.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string list: ${key}`);
  }
  return child as string[];
}
