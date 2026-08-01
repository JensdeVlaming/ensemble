import type { WorkspaceHook } from "../domain/model.ts";
import { runBoundedProcess } from "./process.ts";

export interface WorkspaceHookRunner {
  run(hook: WorkspaceHook, cwd: string, timeoutMs: number): Promise<void>;
}

export class LocalWorkspaceHookRunner implements WorkspaceHookRunner {
  async run(hook: WorkspaceHook, cwd: string, timeoutMs: number): Promise<void> {
    await runBoundedProcess({
      executable: hook.executable,
      args: hook.args,
      cwd,
      env: hookEnvironment(),
      timeoutMs,
      outputLimit: 65_536,
      label: "Workspace hook",
    });
  }
}

function hookEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
