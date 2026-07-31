import type { ExecutionEnvironment, TaskExecutionService } from "../execution/engine.ts";
import { ProviderClaimConflict } from "../providers/provider.ts";
import type { ExecutionRecord, ProviderAdapter, ProviderExecutionState } from "../providers/provider.ts";
import type { RepositoryConfiguration, RuntimeResult, Task } from "../domain/model.ts";

export interface ScheduleReport {
  readonly taskId: string;
  readonly outcome: "completed" | "advanced" | "failed";
  readonly role: string;
  readonly nextRole?: string;
  readonly error?: string;
}

export class Scheduler {
  readonly #active = new Set<string>();
  readonly provider: ProviderAdapter;
  readonly executions: TaskExecutionService;

  constructor(provider: ProviderAdapter, executions: TaskExecutionService) {
    this.provider = provider;
    this.executions = executions;
  }

  async poll(): Promise<readonly ScheduleReport[]> {
    const tasks = await this.provider.discoverTasks({ scope: "workflow_candidates" });
    const reports: ScheduleReport[] = [];
    for (const task of [...tasks].sort((left, right) => left.id.localeCompare(right.id))) {
      if (this.#active.has(task.id)) continue;
      const report = await this.#run(task);
      if (report) reports.push(report);
    }
    return reports;
  }

  async #run(discovered: Task): Promise<ScheduleReport | undefined> {
    this.#active.add(discovered.id);
    try {
      const task = await this.provider.getTask(discovered.id);
      return await this.executions.withEnvironment(task, async (environment) => this.#schedule(task, environment));
    } catch (error) {
      return { taskId: discovered.id, outcome: "failed", role: "unknown", error: errorMessage(error) };
    } finally {
      this.#active.delete(discovered.id);
    }
  }

  async #schedule(task: Task, environment: ExecutionEnvironment): Promise<ScheduleReport | undefined> {
    const config = environment.configuration;
    let state: ProviderExecutionState;
    try {
      state = await this.provider.getExecutionState(task.id);
    } catch (error) {
      return { taskId: task.id, outcome: "failed", role: "unknown", error: errorMessage(error) };
    }
    if (task.dispatchable === false) return undefined;
    const selectedRole = selectRole(state, config);
    if (!state.active && !isEligible(task, state, selectedRole, config)) return undefined;

    let executionId: string | undefined;
    let roleName = selectedRole;
    try {
      const execution = state.active ?? await this.provider.beginExecution(task.id, selectedRole, config.runningStatus);
      executionId = execution.id;
      roleName = execution.role;
      const role = config.workflow.roles.find((candidate) => candidate.name === roleName);
      if (!role) throw new Error(`Unknown role '${roleName}' for task ${task.id}`);
      const [comments, artifacts] = await Promise.all([
        this.provider.getComments(task.id),
        this.provider.getArtifacts(task.id),
      ]);
      const running = await environment.start({ task, role, comments, artifacts, executionId });
      const report = await running.result;
      await this.#synchronize(task, config, roleName, executionId, report.result);
      const terminal = config.terminalOutcomes.includes(report.result.outcome);
      return { taskId: task.id, outcome: terminal ? "completed" : "advanced", role: roleName, nextRole: report.result.nextRole };
    } catch (error) {
      if (error instanceof ProviderClaimConflict) return undefined;
      const message = errorMessage(error);
      if (executionId) {
        await this.provider.failExecution(task.id, executionId, {
          id: executionId,
          role: roleName,
          outcome: "failed",
          summary: message,
          finishedAt: new Date().toISOString(),
        }, config.failedStatus, `Ensemble execution failed: ${message}`);
      }
      return { taskId: task.id, outcome: "failed", role: roleName, error: message };
    }
  }

  async #synchronize(task: Task, config: RepositoryConfiguration, role: string, executionId: string, result: RuntimeResult): Promise<void> {
    const terminal = config.terminalOutcomes.includes(result.outcome);
    if (!terminal && !result.nextRole) throw new Error(`Non-terminal outcome '${result.outcome}' requires nextRole`);
    if (result.nextRole && !config.workflow.roles.some((candidate) => candidate.name === result.nextRole)) {
      throw new Error(`Runtime requested unknown next role: ${result.nextRole}`);
    }
    await this.provider.completeExecution(task.id, executionId, {
      record: {
        id: executionId,
        role,
        outcome: result.outcome,
        summary: result.summary,
        nextRole: terminal ? undefined : result.nextRole,
        finishedAt: new Date().toISOString(),
      },
      comments: [...result.comments, result.summary],
      artifacts: result.artifacts,
      status: terminal ? config.completedStatus : config.runningStatus,
    });
  }
}

function selectRole(state: ProviderExecutionState, config: RepositoryConfiguration): string {
  if (state.active) return state.active.role;
  if (state.nextRole) return state.nextRole;
  const latestFailure = [...state.history].reverse().find((record) => record.outcome === "failed");
  return latestFailure?.role ?? config.initialRole;
}

function isEligible(task: Task, state: ProviderExecutionState, role: string, config: RepositoryConfiguration): boolean {
  if (task.dispatchable === false || task.blockers?.some((blocker) => !blocker.resolved)) return false;
  const latest = state.history.at(-1);
  const retrying = latest?.outcome === "failed";
  if (!retrying) return config.runnableStatuses.includes(task.status);
  const failures = state.history.filter((record: ExecutionRecord) => record.role === role && record.outcome === "failed").length;
  return failures < config.retry.maxFailedAttemptsPerRole;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
