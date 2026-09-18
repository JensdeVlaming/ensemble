import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { HostConfiguration } from "./configuration.ts";
import type { HostController } from "./service.ts";
import { validateHostFilesystem } from "./service.ts";
import { inspectInstanceGuard } from "./instance.ts";
import type { InstanceGuardStatus } from "./instance.ts";

export type DiagnosticCheckStatus = "pass" | "warning" | "fail";

export interface DiagnosticCheck {
  readonly id: string;
  readonly status: DiagnosticCheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly checks: readonly DiagnosticCheck[];
}

export interface HostStatusReport {
  readonly generatedAt: string;
  readonly controller: InstanceGuardStatus;
  readonly configurationPath: string;
  readonly statePath: string;
  readonly workspacePath?: string;
  readonly repositories?: readonly string[];
  readonly runtimes?: readonly string[];
  readonly configurationError?: string;
}

export async function diagnoseHost(
  controller: HostController,
  statePath: string,
): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];
  const redact = (value: string): string => {
    try { return bounded(controller.secrets.redact(value)); }
    catch { return "Diagnostic failed while redacting its detail"; }
  };
  await check(checks, "host.filesystem", "Configured executables and directories are accessible",
    () => validateHostFilesystem(controller.configuration), redact);
  await check(checks, "host.state", "State directory is readable and writable",
    () => access(statePath, constants.R_OK | constants.W_OK), redact);

  try {
    const guard = await inspectInstanceGuard(statePath);
    if (guard.state === "invalid") checks.push(result("instance.guard", "fail", "Instance guard is malformed or unsafe"));
    else if (guard.state === "stale") checks.push(result("instance.guard", "warning", `Stale instance guard for PID ${guard.pid}`));
    else if (guard.state === "running") checks.push(result("instance.guard", "pass", `Controller process ${guard.pid} is running`));
    else checks.push(result("instance.guard", "pass", "No controller process is running"));
  } catch (error) {
    checks.push(result("instance.guard", "fail", redact(errorMessage(error))));
  }

  for (const repository of controller.repositories) {
    await check(checks, `repository.${repository.provider.repository.id}.provider`, "Provider configuration and read access are valid",
      () => repository.provider.validateConfiguration(), redact);
    await check(checks, `repository.${repository.provider.repository.id}.configuration`, "Repository configuration and runtime settings are valid",
      async () => { await repository.scheduler.reloadConfiguration(); }, redact);
  }

  const diagnosticCwd = controller.configuration.repositories[0]?.configurationPath;
  for (const configured of controller.configuration.runtimes) {
    const runtime = controller.runtimes.get(configured.name);
    if (!runtime.diagnose || !diagnosticCwd) {
      checks.push(result(`runtime.${configured.name}.protocol`, "fail", "Runtime does not support a non-dispatching diagnostic"));
      continue;
    }
    await check(checks, `runtime.${configured.name}.protocol`, `${configured.type} protocol checks succeeded`,
      () => runtime.diagnose!({ cwd: diagnosticCwd }), redact);
  }

  return Object.freeze({
    healthy: !checks.some((entry) => entry.status === "fail"),
    checks: Object.freeze(checks),
  });
}

export async function hostStatus(
  configurationPath: string,
  statePath: string,
  configuration?: HostConfiguration,
  configurationError?: unknown,
): Promise<HostStatusReport> {
  const controller = await inspectInstanceGuard(statePath);
  return Object.freeze({
    generatedAt: new Date().toISOString(),
    controller,
    configurationPath,
    statePath,
    ...(configuration ? {
      workspacePath: configuration.workspace.root,
      repositories: Object.freeze(configuration.repositories.map((entry) => entry.id).sort()),
      runtimes: Object.freeze(configuration.runtimes.map((entry) => entry.name).sort()),
    } : {}),
    ...(configurationError === undefined ? {} : { configurationError: bounded(errorMessage(configurationError)) }),
  });
}

async function check(
  checks: DiagnosticCheck[],
  id: string,
  success: string,
  operation: () => Promise<unknown>,
  sanitize: (value: string) => string,
): Promise<void> {
  try {
    await operation();
    checks.push(result(id, "pass", success));
  } catch (error) {
    checks.push(result(id, "fail", sanitize(errorMessage(error))));
  }
}

function result(id: string, status: DiagnosticCheckStatus, detail: string): DiagnosticCheck {
  return Object.freeze({ id, status, detail: bounded(detail) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string): string {
  return value.length <= 1_024 ? value : `${value.slice(0, 1_023)}…`;
}
