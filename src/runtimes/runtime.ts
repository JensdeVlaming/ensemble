import type {
  Artifact,
  BlockingRequest,
  PortableJsonValue,
  ResumeContext,
  RuntimeContext,
  RuntimeResult,
} from "../domain/model.ts";

interface EventBase {
  readonly at: string;
  readonly executionId: string;
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
  | (EventBase & { readonly type: "run_failed"; readonly error: string })
  | (EventBase & { readonly type: "approval_requested"; readonly request: BlockingRequest })
  | (EventBase & { readonly type: "user_input_requested"; readonly request: BlockingRequest })
  | (EventBase & { readonly type: "tool_elicitation_requested"; readonly request: BlockingRequest })
  | (EventBase & { readonly type: "usage_updated"; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number })
  | (EventBase & { readonly type: "rate_limit_updated"; readonly limitId: string; readonly usedPercent?: number; readonly resetsAt?: string })
  | (EventBase & { readonly type: "heartbeat" });

export function validatePortableToolResult(value: unknown): PortableJsonValue {
  return clonePortableJson(value, "Runtime tool result", 262_144);
}

export function validateRuntimeTools(tools: readonly import("../domain/model.ts").RuntimeTool[]): readonly import("../domain/model.ts").RuntimeTool[] {
  if (tools.length > 64) throw new Error("Runtime tool collection exceeds 64 tools");
  const names = new Set<string>();
  let aggregateBytes = 0;
  const aggregateNodes = { nodes: 0 };
  return Object.freeze(tools.map((tool) => {
    if (!tool || typeof tool !== "object") throw new Error("Runtime tool must be an object");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(tool.name)) throw new Error(`Invalid runtime tool name: ${tool.name}`);
    if (!tool.description.trim() || Buffer.byteLength(tool.description, "utf8") > 1_024) {
      throw new Error(`Invalid runtime tool description: ${tool.name}`);
    }
    if (names.has(tool.name)) throw new Error(`Duplicate runtime tool: ${tool.name}`);
    names.add(tool.name);
    validateJsonSchema(tool.inputSchema, 0);
    if (tool.inputSchema.type !== "object") throw new Error(`Runtime tool schema must describe an object: ${tool.name}`);
    const schema = clonePortableJson(tool.inputSchema, "Runtime tool schema", 131_072, aggregateNodes) as Readonly<Record<string, PortableJsonValue>>;
    aggregateBytes += Buffer.byteLength(tool.name, "utf8") + Buffer.byteLength(tool.description, "utf8")
      + Buffer.byteLength(JSON.stringify(schema), "utf8");
    if (aggregateBytes > 262_144) throw new Error("Runtime tool collection exceeds aggregate size limit");
    if (typeof tool.invoke !== "function") throw new Error(`Runtime tool invocation is required: ${tool.name}`);
    return Object.freeze({ name: tool.name, description: tool.description,
      inputSchema: schema,
      invoke: async (input: unknown, context?: import("../domain/model.ts").RuntimeToolInvocationContext) => {
        const normalized = clonePortableJson(input, "Runtime tool input", 131_072);
        validateSchemaValue(schema, normalized);
        return validatePortableToolResult(await tool.invoke(normalized, context));
      } });
  }));
}

export interface PreparedRun {
  readonly id: string;
  readonly context: RuntimeContext;
  readonly payload: unknown;
  readonly operatorRequests?: OperatorRequestPolicy;
}

export type OperatorRequestPolicy = "auto" | "reject" | "block";

export interface RuntimeSession {
  readonly id: string;
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly result: Promise<RuntimeResult>;
}

export interface Runtime {
  readonly name: string;
  validateConfiguration?(config: Readonly<Record<string, unknown>>): void;
  /** Performs a non-dispatching installation/protocol check. */
  diagnose?(context: { readonly cwd: string }): Promise<void>;
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

function validatePortableJson(value: unknown, depth: number, seen: Set<object>, budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > 10_000) throw new Error("Portable JSON exceeds maximum node count");
  if (depth > 12) throw new Error("Portable JSON exceeds maximum depth");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 65_536) throw new Error("Portable JSON string is too large");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Portable JSON numbers must be finite");
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Portable JSON must be acyclic JSON data");
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Portable JSON array is too large");
    for (const child of value) validatePortableJson(child, depth + 1, seen, budget);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("Portable JSON objects must be plain objects");
    }
    const entries = Object.entries(value);
    if (entries.length > 1_000) throw new Error("Portable JSON object is too large");
    for (const [key, child] of entries) {
      if (!key || Buffer.byteLength(key, "utf8") > 256 || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("Portable JSON contains an invalid key");
      }
      validatePortableJson(child, depth + 1, seen, budget);
    }
  }
  seen.delete(value);
}

function clonePortableJson(value: unknown, label: string, maximumBytes: number, budget = { nodes: 0 }): PortableJsonValue {
  validatePortableJson(value, 0, new Set<object>(), budget);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new Error(`${label} exceeds maximum size`);
  return deepFreezeJson(structuredClone(value as PortableJsonValue));
}

const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const schemaKeys = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum"]);

function validateJsonSchema(value: unknown, depth: number): asserts value is Readonly<Record<string, PortableJsonValue>> {
  if (depth > 12 || !value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Runtime tool schema must use the supported object schema subset");
  }
  const schema = value as Record<string, unknown>;
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) throw new Error(`Unsupported runtime tool schema keyword: ${key}`);
  if (typeof schema.type !== "string" || !schemaTypes.has(schema.type)) throw new Error("Runtime tool schema requires a supported type");
  if (schema.description !== undefined && (typeof schema.description !== "string"
    || Buffer.byteLength(schema.description, "utf8") > 1_024)) throw new Error("Runtime tool schema description is invalid");
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100) throw new Error("Runtime tool schema enum is invalid");
    clonePortableJson(schema.enum, "Runtime tool schema enum", 65_536);
  }
  if (schema.type === "object") {
    if (schema.properties !== undefined) {
      if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
        throw new Error("Runtime tool schema properties are invalid");
      }
      for (const [name, child] of Object.entries(schema.properties)) {
        if (!name || Buffer.byteLength(name, "utf8") > 256) throw new Error("Runtime tool schema property name is invalid");
        validateJsonSchema(child, depth + 1);
      }
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string" || !item)
        || new Set(schema.required).size !== schema.required.length) throw new Error("Runtime tool schema required list is invalid");
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (schema.required.some((item) => !properties || !Object.hasOwn(properties, item as string))) {
        throw new Error("Runtime tool schema requires an undefined property");
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
      throw new Error("Runtime tool schema additionalProperties must be boolean");
    }
    if (schema.items !== undefined) throw new Error("Runtime object schema cannot define items");
  } else if (schema.type === "array") {
    if (schema.items === undefined) throw new Error("Runtime array schema requires items");
    validateJsonSchema(schema.items, depth + 1);
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      throw new Error("Runtime array schema has object-only keywords");
    }
  } else if (schema.properties !== undefined || schema.required !== undefined
    || schema.additionalProperties !== undefined || schema.items !== undefined) {
    throw new Error("Runtime scalar schema has incompatible keywords");
  }
  if (Array.isArray(schema.enum)) {
    for (const candidate of schema.enum) validateSchemaValue(schema as Readonly<Record<string, PortableJsonValue>>, candidate as PortableJsonValue);
  }
}

function validateSchemaValue(schema: Readonly<Record<string, PortableJsonValue>>, value: PortableJsonValue): void {
  const type = schema.type;
  const matches = type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
    : type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : typeof value === type;
  if (!matches) throw new Error("Runtime tool input does not match its schema");
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    throw new Error("Runtime tool input does not match its schema enum");
  }
  if (type === "object") {
    const object = value as Readonly<Record<string, PortableJsonValue>>;
    const properties = (schema.properties ?? {}) as Readonly<Record<string, Readonly<Record<string, PortableJsonValue>>>>;
    const required = (schema.required ?? []) as readonly string[];
    for (const name of required) if (!Object.hasOwn(object, name)) throw new Error("Runtime tool input is missing a required property");
    for (const [name, child] of Object.entries(object)) {
      const childSchema = properties[name];
      if (!childSchema) {
        if (schema.additionalProperties === false) throw new Error("Runtime tool input has an unexpected property");
        continue;
      }
      validateSchemaValue(childSchema, child);
    }
  } else if (type === "array") {
    const items = schema.items as Readonly<Record<string, PortableJsonValue>>;
    for (const child of value as readonly PortableJsonValue[]) validateSchemaValue(items, child);
  }
}

function deepFreezeJson<T extends PortableJsonValue>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}
