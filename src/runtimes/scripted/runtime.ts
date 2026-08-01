import { randomUUID } from "node:crypto";
import type { ResumeContext, RuntimeContext, RuntimeResult } from "../../domain/model.ts";
import type { PreparedRun, Runtime, RuntimeEvent, RuntimeSession } from "../runtime.ts";

export class ScriptedRuntime implements Runtime {
  readonly name: string;
  readonly contexts: RuntimeContext[] = [];
  readonly #result: RuntimeResult;
  #cancelled = false;

  constructor(name: string, result: RuntimeResult) {
    this.name = name;
    this.#result = result;
  }

  validateConfiguration(config: Readonly<Record<string, unknown>>): void {
    operatorRequestPolicy(config);
  }

  async prepare(context: RuntimeContext): Promise<PreparedRun> {
    this.contexts.push(context);
    return { id: randomUUID(), context, payload: context, operatorRequests: operatorRequestPolicy(context.runtimeConfig) };
  }

  async start(prepared: PreparedRun): Promise<RuntimeSession> {
    const result = this.#result;
    const events = async function* (): AsyncIterable<RuntimeEvent> {
      yield { type: "run_started", at: new Date().toISOString(), executionId: prepared.context.executionId, sessionId: prepared.id };
      yield { type: "run_completed", at: new Date().toISOString(), executionId: prepared.context.executionId, result };
    };
    return { id: prepared.id, events: events(), result: Promise.resolve(result) };
  }

  async resume(session: RuntimeSession, _context: ResumeContext): Promise<RuntimeSession> {
    return session;
  }

  async cancel(_session: RuntimeSession): Promise<void> {
    this.#cancelled = true;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }
}

function operatorRequestPolicy(config: Readonly<Record<string, unknown>>): "auto" | "reject" | "block" {
  const value = config.operatorRequests ?? "reject";
  if (value !== "auto" && value !== "reject" && value !== "block") throw new Error("Invalid scripted operatorRequests policy");
  return value;
}
