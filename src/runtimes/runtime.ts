import type {
  Artifact,
  ResumeContext,
  RuntimeContext,
  RuntimeResult,
} from "../domain/model.ts";

interface EventBase {
  readonly at: string;
}

export type RuntimeEvent =
  | (EventBase & { readonly type: "run_started"; readonly sessionId: string })
  | (EventBase & { readonly type: "progress_updated"; readonly message: string; readonly percent?: number })
  | (EventBase & { readonly type: "tool_started"; readonly tool: string })
  | (EventBase & { readonly type: "tool_finished"; readonly tool: string; readonly success: boolean })
  | (EventBase & { readonly type: "validation_started"; readonly name: string })
  | (EventBase & { readonly type: "validation_finished"; readonly name: string; readonly success: boolean })
  | (EventBase & { readonly type: "artifact_created"; readonly artifact: Artifact })
  | (EventBase & { readonly type: "comment_requested"; readonly body: string })
  | (EventBase & { readonly type: "next_agent_requested"; readonly role: string })
  | (EventBase & { readonly type: "run_completed"; readonly result: RuntimeResult })
  | (EventBase & { readonly type: "run_failed"; readonly error: string });

export interface PreparedRun {
  readonly id: string;
  readonly context: RuntimeContext;
  readonly payload: unknown;
}

export interface RuntimeSession {
  readonly id: string;
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly result: Promise<RuntimeResult>;
}

export interface Runtime {
  readonly name: string;
  prepare(context: RuntimeContext): Promise<PreparedRun>;
  start(prepared: PreparedRun): Promise<RuntimeSession>;
  resume(session: RuntimeSession, context: ResumeContext): Promise<RuntimeSession>;
  cancel(session: RuntimeSession): Promise<void>;
}

export class RuntimeRegistry {
  readonly #runtimes = new Map<string, Runtime>();

  constructor(runtimes: readonly Runtime[] = []) {
    for (const runtime of runtimes) this.register(runtime);
  }

  register(runtime: Runtime): void {
    if (this.#runtimes.has(runtime.name)) {
      throw new Error(`Runtime already registered: ${runtime.name}`);
    }
    this.#runtimes.set(runtime.name, runtime);
  }

  get(name: string): Runtime {
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new Error(`Unknown runtime: ${name}`);
    return runtime;
  }
}
