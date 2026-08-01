import { randomUUID } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { HostConfiguration, HostRuntimeConfiguration } from "./configuration.ts";
import { runtimeEnvironment } from "./configuration.ts";
import { ConfigurationReloadError, HostSecretResolver, RepositoryConfigLoader,
  RepositoryConfigurationManager } from "../execution/repository.ts";
import { ExecutionEngine } from "../execution/engine.ts";
import { GitRepositoryDriver, LocalWorkspaceManager } from "../execution/workspace.ts";
import { JsonLinesOperationalLogSink, StructuredLogger } from "../observability/logging.ts";
import type { JsonLinesWritable } from "../observability/logging.ts";
import { OrchestratorService } from "../orchestration/service.ts";
import type { OrchestratorRegistration } from "../orchestration/service.ts";
import { Scheduler } from "../orchestration/scheduler.ts";
import { VikunjaProvider } from "../providers/vikunja/adapter.ts";
import { RuntimeRegistry } from "../runtimes/runtime.ts";
import { CodexCliTransport } from "../runtimes/codex/cli-transport.ts";
import { CodexRuntime } from "../runtimes/codex/runtime.ts";

export interface HostControllerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly writable?: JsonLinesWritable;
  readonly serviceInstanceId?: string;
  readonly now?: () => Date;
}

interface HostRepositoryRuntime {
  readonly provider: VikunjaProvider;
  readonly configurations: RepositoryConfigurationManager;
  readonly scheduler: Scheduler;
}

export class HostController {
  readonly configuration: HostConfiguration;
  readonly service: OrchestratorService;
  readonly repositories: readonly HostRepositoryRuntime[];
  readonly runtimes: RuntimeRegistry;
  readonly secrets: HostSecretResolver;
  readonly #startupTimeoutMs: number;

  constructor(
    configuration: HostConfiguration,
    service: OrchestratorService,
    repositories: readonly HostRepositoryRuntime[],
    runtimes: RuntimeRegistry,
    secrets: HostSecretResolver,
  ) {
    this.configuration = configuration;
    this.service = service;
    this.repositories = Object.freeze([...repositories]);
    this.runtimes = runtimes;
    this.secrets = secrets;
    this.#startupTimeoutMs = configuration.service.startupTimeoutMs;
  }

  async validate(): Promise<void> {
    await within(Promise.all(this.repositories.map(async ({ provider, configurations }) => {
      await provider.validateConfiguration();
      const loaded = await configurations.reload();
      this.runtimes.get(loaded.configuration.runtime.name);
    })).then(() => undefined), this.#startupTimeoutMs, "Host validation timed out");
  }

  run(): Promise<void> { return this.service.start(); }
  shutdown() { return this.service.shutdown(); }
}

export async function buildHostController(
  configuration: HostConfiguration,
  options: HostControllerOptions = {},
): Promise<HostController> {
  const environment = options.environment ?? process.env;
  const secrets = new HostSecretResolver(environment);
  const resolvedTokens = new Map(configuration.repositories.map((repository) => [
    repository.id,
    secrets.resolve(repository.provider.token, `repositories.${repository.id}.provider.token`),
  ]));
  const logger = new StructuredLogger({
    serviceInstanceId: options.serviceInstanceId ?? randomUUID(),
    sink: new JsonLinesOperationalLogSink(options.writable ?? process.stdout),
    ...(options.now ? { now: options.now } : {}),
    redact: (value) => secrets.redact(value),
    minimumLevel: configuration.logging.level,
  });
  const runtimes = new RuntimeRegistry(configuration.runtimes.map((runtime) => createRuntime(runtime, environment)));
  const repositoryLoader = new RepositoryConfigLoader();
  const repositories: HostRepositoryRuntime[] = [];
  const registrations: OrchestratorRegistration[] = [];

  for (const registration of configuration.repositories) {
    const repository = Object.freeze({
      id: registration.id,
      url: registration.url,
      ...(registration.branch ? { defaultBranch: registration.branch, branch: registration.branch } : {}),
    });
    const provider = new VikunjaProvider({
      baseUrl: registration.provider.baseUrl,
      token: resolvedTokens.get(registration.id)!,
      projectId: registration.provider.projectId,
      viewId: registration.provider.viewId,
      repository,
      requiredLabels: registration.provider.requiredLabels,
      ...(registration.provider.requiredAssignee ? { requiredAssignee: registration.provider.requiredAssignee } : {}),
      ...(registration.provider.statusLabels ? { statusLabels: registration.provider.statusLabels } : {}),
      operationalEvents: logger,
    });
    const configurations = new RepositoryConfigurationManager(
      repositoryLoader,
      repository,
      registration.configurationPath,
      { redact: (value) => secrets.redact(value) },
    );
    const workspaceRoot = join(configuration.workspace.root, safeSegment(registration.id));
    const workspaces = new LocalWorkspaceManager(
      workspaceRoot,
      new GitRepositoryDriver(configuration.workspace.gitExecutable),
      configuration.workspace.preserve,
    );
    const engine = new ExecutionEngine(runtimes, workspaces, configurations, () => undefined, 100,
      () => new Date().toISOString(), logger);
    const scheduler = new Scheduler(provider, engine, { events: logger });
    let initial: Awaited<ReturnType<RepositoryConfigurationManager["reload"]>> | undefined;
    try {
      initial = await configurations.reload();
      runtimes.get(initial.configuration.runtime.name);
    } catch (error) {
      if (!(error instanceof ConfigurationReloadError)) throw error;
      // The service owns retrying an initially invalid repository configuration.
      // `ensemble validate` still reports this through HostController.validate().
    }
    repositories.push({ provider, configurations, scheduler });
    registrations.push({
      id: registration.id,
      scheduler,
      startupTimeoutMs: initial?.configuration.timeouts.startupMs ?? configuration.service.startupTimeoutMs,
      pollIntervalMs: initial?.configuration.service.pollIntervalMs ?? 30_000,
      drainTimeoutMs: initial?.configuration.shutdown.drainTimeoutMs ?? 60_000,
      cancellationTimeoutMs: initial?.configuration.timeouts.cancellationMs ?? 10_000,
    });
  }
  return new HostController(configuration, new OrchestratorService(registrations, undefined, undefined, logger),
    repositories, runtimes, secrets);
}

export async function validateHostFilesystem(configuration: HostConfiguration): Promise<void> {
  await executable(configuration.workspace.gitExecutable, "Git executable");
  for (const runtime of configuration.runtimes) await executable(runtime.executable, `${runtime.name} executable`);
  await directory(configuration.workspace.root, "Workspace root");
  for (const repository of configuration.repositories) await directory(repository.configurationPath, `${repository.id} configuration path`);
}

export async function initializeHostDirectories(configuration: HostConfiguration, statePath: string): Promise<void> {
  await Promise.all([
    mkdir(configuration.workspace.root, { recursive: true, mode: 0o700 }),
    mkdir(statePath, { recursive: true, mode: 0o700 }),
  ]);
}

function createRuntime(
  runtime: HostRuntimeConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
): CodexRuntime {
  if (runtime.type !== "codex-cli") throw new Error(`Unsupported runtime type: ${runtime.type}`);
  return new CodexRuntime(new CodexCliTransport({
    executable: runtime.executable,
    executionArguments: runtime.executionArguments,
    environment: runtimeEnvironment(runtime.environment.inherit, environment),
  }), undefined, undefined, undefined, undefined, runtime.name);
}

async function executable(path: string, name: string): Promise<void> {
  try {
    const details = await stat(path);
    if (!details.isFile()) throw new Error(`${name} is not a file: ${path}`);
    await access(path, constants.X_OK);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(name)) throw error;
    throw new Error(`${name} is not executable: ${path}`);
  }
}

async function directory(path: string, name: string): Promise<void> {
  const details = await stat(path);
  if (!details.isDirectory()) throw new Error(`${name} is not a directory: ${path}`);
}

function safeSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  if (!segment) throw new Error(`Repository ID cannot form a workspace segment: ${value}`);
  return segment;
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs === 0) {
    void promise.catch(() => undefined);
    return Promise.reject(new Error(message));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
