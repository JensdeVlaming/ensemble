import { spawn } from "node:child_process";

export interface BoundedProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly label: string;
}

export interface BoundedProcessResult {
  readonly stdout: string;
}

export class ProcessTerminationUnconfirmedError extends Error {
  constructor(label: string) {
    super(`${label} termination could not be confirmed`);
    this.name = "ProcessTerminationUnconfirmedError";
  }
}

/** Runs one argv-only child and does not release ownership before bounded exit. */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(options.executable, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: ownsProcessGroup,
    });
    let stdout = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let closed = false;
    let deadline: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationPoll: NodeJS.Timeout | undefined;

    const settle = (work: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (terminationPoll) clearTimeout(terminationPoll);
      work();
    };
    const treeAlive = () => {
      if (!ownsProcessGroup || child.pid === undefined) return !closed;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        return true;
      }
    };
    const killTree = () => {
      if (ownsProcessGroup && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    };
    const confirmTermination = () => {
      if (closed && !treeAlive()) {
        settle(() => reject(failure!));
        return;
      }
      terminationPoll = setTimeout(confirmTermination, 10);
      terminationPoll.unref?.();
    };
    const terminate = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      killTree();
      terminationPoll = setTimeout(confirmTermination, 0);
      terminationPoll.unref?.();
      terminationTimer = setTimeout(() => settle(() => reject(new ProcessTerminationUnconfirmedError(options.label))), 1_000);
      terminationTimer.unref?.();
    };
    const consume = (chunk: Buffer | string, capture: boolean) => {
      if (failure || settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > options.outputLimit) {
        terminate(new Error(`${options.label} output exceeded its limit`));
        return;
      }
      if (capture) stdout += String(chunk);
    };
    child.stdout.on("data", (chunk: Buffer | string) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer | string) => consume(chunk, false));
    deadline = setTimeout(() => terminate(new Error(`${options.label} timed out`)), options.timeoutMs);
    deadline.unref?.();
    child.once("error", (error) => settle(() => reject(failure
      ?? new Error(`${options.label} failed to start: ${error instanceof Error ? error.name : "unknown"}`))));
    child.once("close", (code, signal) => {
      closed = true;
      if (failure) return;
      if (treeAlive()) {
        terminate(new Error(`${options.label} left background processes running`));
        return;
      }
      settle(() => code === 0
        ? resolve(Object.freeze({ stdout }))
        : reject(new Error(`${options.label} failed (${signal ?? code ?? "unknown"})`)));
    });
  });
}
