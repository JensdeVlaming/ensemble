import { mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RepositoryRef, Task, Workspace } from "../domain/model.ts";

export interface RepositoryDriver {
  materialize(repository: RepositoryRef, target: string): Promise<void>;
}

export class GitRepositoryDriver implements RepositoryDriver {
  readonly executable: string;

  constructor(executable = "git") {
    this.executable = executable;
  }

  async materialize(repository: RepositoryRef, target: string): Promise<void> {
    const branch = repository.branch ?? repository.defaultBranch;
    const arguments_ = ["clone", "--no-tags"];
    if (branch) arguments_.push("--branch", branch, "--single-branch");
    arguments_.push("--", repository.url, target);
    await run(this.executable, arguments_);
  }
}

export interface WorkspaceManager {
  create(task: Task): Promise<Workspace>;
  restore(task: Task): Promise<Workspace | undefined>;
  cleanup(workspace: Workspace): Promise<void>;
}

export class LocalWorkspaceManager implements WorkspaceManager {
  readonly #basePath: string;
  readonly #repositories: RepositoryDriver;
  readonly #preserve: boolean;

  constructor(
    basePath: string,
    repositories: RepositoryDriver,
    preserve = true,
  ) {
    this.#basePath = basePath;
    this.#repositories = repositories;
    this.#preserve = preserve;
  }

  async create(task: Task): Promise<Workspace> {
    const root = join(this.#basePath, safeSegment(task.id));
    const workspace = {
      root,
      repositoryPath: join(root, "repository"),
      runtimePath: join(root, ".ensemble-runtime"),
    };
    try {
      await mkdir(workspace.runtimePath, { recursive: true });
      await this.#repositories.materialize(task.repository, workspace.repositoryPath);
      return workspace;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async restore(task: Task): Promise<Workspace | undefined> {
    const root = join(this.#basePath, safeSegment(task.id));
    const workspace = {
      root,
      repositoryPath: join(root, "repository"),
      runtimePath: join(root, ".ensemble-runtime"),
    };
    try {
      const [repository, runtime] = await Promise.all([
        stat(workspace.repositoryPath),
        stat(workspace.runtimePath),
      ]);
      return repository.isDirectory() && runtime.isDirectory() ? workspace : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async cleanup(workspace: Workspace): Promise<void> {
    if (!this.#preserve) await rm(workspace.root, { recursive: true, force: true });
  }
}

function safeSegment(id: string): string {
  const value = id.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  if (!value) throw new Error(`Task id cannot form a workspace name: ${id}`);
  return value;
}

function run(executable: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Repository materialization failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
    });
  });
}
