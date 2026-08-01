import assert from "node:assert/strict";
import test from "node:test";
import { CodexCliTransport } from "../src/index.ts";
import type { CodexProcess, CodexProcessLauncher } from "../src/index.ts";

class FakeProcess implements CodexProcess {
  killed = false;
  readonly stdout: AsyncIterable<string>;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #finish?: () => void;
  constructor(lines: readonly string[], exitError?: Error, pending = false) {
    this.stdout = (async function* () { for (const line of lines) yield `${line}\n`; })();
    if (pending) {
      let finish!: () => void;
      this.exit = new Promise((resolve) => { finish = () => resolve({ code: null, signal: "SIGTERM" }); });
      this.#finish = finish;
    } else {
      this.exit = exitError ? Promise.reject(exitError) : Promise.resolve({ code: 0, signal: null });
    }
  }
  kill(): void { this.killed = true; this.#finish?.(); }
}

class FakeLauncher implements CodexProcessLauncher {
  readonly calls: Array<{
    executable: string;
    arguments_: readonly string[];
    cwd: string;
    environment: Readonly<Record<string, string>>;
  }> = [];
  readonly processes: FakeProcess[];
  constructor(processes: FakeProcess[]) { this.processes = processes; }
  launch(executable: string, arguments_: readonly string[], options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }): CodexProcess {
    this.calls.push({ executable, arguments_, cwd: options.cwd, environment: options.environment });
    const process = this.processes.shift();
    if (!process) throw new Error("No fake process");
    return process;
  }
}

function successful(id: string, summary = "done"): FakeProcess {
  return new FakeProcess([
    JSON.stringify({ type: "thread.started", thread_id: id }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ outcome: "approved", summary, comments: [], artifacts: [] }) } }),
    JSON.stringify({ type: "turn.completed" }),
  ]);
}

test("Codex CLI transport builds argv, normalizes JSONL, extracts results, and resumes", async () => {
  const launcher = new FakeLauncher([successful("thread-1"), successful("thread-2", "resumed")]);
  const transport = new CodexCliTransport({ executable: "codex-test", launcher,
    executionArguments: ["--sandbox", "workspace-write"], environment: { PATH: "/bin", CODEX_HOME: "/codex" } });
  const first = await transport.start({ id: "request", cwd: "/workspace", prompt: "do work", config: { model: "configured-model" } });
  const messages = [];
  for await (const message of first.messages) messages.push(message);
  assert.deepEqual(messages, [
    { type: "tool_started", tool: "npm test" },
    { type: "tool_finished", tool: "npm test", success: true },
  ]);
  assert.deepEqual(await first.result, { outcome: "approved", summary: "done", comments: [], artifacts: [] });
  assert.deepEqual(launcher.calls[0], {
    executable: "codex-test",
    arguments_: ["exec", "--json", "--sandbox", "workspace-write", "--model", "configured-model", "do work"],
    cwd: "/workspace",
    environment: { PATH: "/bin", CODEX_HOME: "/codex" },
  });
  const resumed = await transport.resume(first, "continue");
  assert.equal((await resumed.result as { summary: string }).summary, "resumed");
  assert.deepEqual(launcher.calls[1]?.arguments_, ["exec", "resume", "--json", "thread-1", "continue"]);
  assert.equal(launcher.calls[1]?.cwd, "/workspace");
});

test("Codex CLI transport rejects malformed JSONL and non-zero exits", async () => {
  const malformed = new CodexCliTransport({ launcher: new FakeLauncher([new FakeProcess([
    JSON.stringify({ type: "thread.started", thread_id: "bad-json" }), "not-json",
  ])]) });
  const badSession = await malformed.start({ id: "x", cwd: "/w", prompt: "x", config: {} });
  await assert.rejects(badSession.result, /malformed JSONL/u);

  const failed = new CodexCliTransport({ launcher: new FakeLauncher([new FakeProcess([
    JSON.stringify({ type: "thread.started", thread_id: "bad-exit" }),
  ], new Error("exit 7"))]) });
  const failedSession = await failed.start({ id: "x", cwd: "/w", prompt: "x", config: {} });
  await assert.rejects(failedSession.result, /exit 7/u);
});

test("Codex CLI transport cancellation terminates the active process", async () => {
  const process = new FakeProcess([JSON.stringify({ type: "thread.started", thread_id: "cancel-me" })], undefined, true);
  const transport = new CodexCliTransport({ launcher: new FakeLauncher([process]) });
  const session = await transport.start({ id: "x", cwd: "/w", prompt: "x", config: {} });
  await transport.cancel(session);
  assert.equal(process.killed, true);
});
