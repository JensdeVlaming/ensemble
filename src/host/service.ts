import { randomUUID } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { RepositoryRef } from "../domain/model.ts";
import type { HostConfiguration, HostRuntimeConfiguration } from "./configuration.ts";
import { runtimeEnvironment } from "./configuration.ts";
import { WebhookServer } from "./webhook-server.ts";
import type { WebhookServerStartReport } from "./webhook-server.ts";
import { ConfigurationReloadError, HostSecretResolver, RepositoryConfigLoader,
  RepositoryConfigurationManager } from "../execution/repository.ts";
import { ExecutionEngine } from "../execution/engine.ts";
import { GitRepositoryDriver, LocalWorkspaceManager } from "../execution/workspace.ts";
import { JsonLinesOperationalLogSink, StructuredLogger } from "../observability/logging.ts";
import type { JsonLinesWritable } from "../observability/logging.ts";
import { OrchestratorService } from "../orchestration/service.ts";
import type { ServiceSnapshot } from "../orchestration/service.ts";
import type { OrchestratorRegistration } from "../orchestration/service.ts";
import { Scheduler } from "../orchestration/scheduler.ts";
import type { ProviderAdapter } from "../providers/provider.ts";
import { AzureDevOpsProvider } from "../providers/azure-devops/adapter.ts";
import { VikunjaProvider } from "../providers/vikunja/adapter.ts";
import { RuntimeRegistry } from "../runtimes/runtime.ts";
import { CodexAppServerTransport } from "../runtimes/codex/app-server-transport.ts";
import { CodexRuntime } from "../runtimes/codex/runtime.ts";

export interface HostControllerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly writable?: JsonLinesWritable;
  readonly serviceInstanceId?: string;
  readonly now?: () => Date;
}

interface HostRepositoryRuntime {
  readonly provider: HostedProvider;
  readonly configurations: RepositoryConfigurationManager;
  readonly scheduler: Scheduler;
}

type HostedProvider = ProviderAdapter & {
  readonly repository: RepositoryRef;
  validateConfiguration(): Promise<void>;
};

export interface HostServiceLifecycle {
  readonly state: OrchestratorService["state"];
  start(): Promise<void>;
  shutdown(): ReturnType<OrchestratorService["shutdown"]>;
  snapshot(now?: () => Date): ServiceSnapshot;
}

interface HostWebhookIngress {
  start(): Promise<WebhookServerStartReport>;
  close(): Promise<void>;
}

interface HostSignalSource {
  addListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

const processSignals: HostSignalSource = {
  addListener: (signal, listener) => { process.on(signal, listener); },
  removeListener: (signal, listener) => { process.off(signal, listener); },
};

const ignoredServiceSignals = Object.freeze({
  addListener: () => undefined,
  removeListener: () => undefined,
});

export class HostController<TService extends HostServiceLifecycle = OrchestratorService> {
  readonly configuration: HostConfiguration;
  readonly service: TService;
  readonly repositories: readonly HostRepositoryRuntime[];
  readonly runtimes: RuntimeRegistry;
  readonly secrets: HostSecretResolver;
  readonly #startupTimeoutMs: number;
  readonly #webhook?: HostWebhookIngress;
  readonly #signals: HostSignalSource;
  readonly #interruptListener = (): void => { void this.shutdown().catch(() => undefined); };
  readonly #terminateListener = (): void => { void this.shutdown().catch(() => undefined); };
  #signalsInstalled = false;
  #webhookReady = false;
  #webhookClose?: Promise<void>;
  #run?: Promise<void>;
  #shutdown?: ReturnType<OrchestratorService["shutdown"]>;

  constructor(
    configuration: HostConfiguration,
    service: TService,
    repositories: readonly HostRepositoryRuntime[],
    runtimes: RuntimeRegistry,
    secrets: HostSecretResolver,
    webhook?: HostWebhookIngress,
    signals: HostSignalSource = processSignals,
  ) {
    this.configuration = configuration;
    this.service = service;
    this.repositories = Object.freeze([...repositories]);
    this.runtimes = runtimes;
    this.secrets = secrets;
    this.#startupTimeoutMs = configuration.service.startupTimeoutMs;
    this.#webhook = webhook;
    this.#signals = signals;
  }

  async validate(): Promise<void> {
    await within(Promise.all(this.repositories.map(async ({ provider, scheduler }) => {
      await provider.validateConfiguration();
      await scheduler.reloadConfiguration();
    })).then(() => undefined), this.#startupTimeoutMs, "Host validation timed out");
  }

  run(): Promise<void> {
    this.#run ??= this.#runService();
    return this.#run;
  }

  shutdown(): ReturnType<OrchestratorService["shutdown"]> {
    this.#shutdown ??= this.#shutdownService();
    return this.#shutdown;
  }
  snapshot(now?: () => Date): ServiceSnapshot { return this.service.snapshot(now); }
  health(): boolean { return this.service.state !== "stopped"; }
  readiness(): boolean { return (!this.#webhook || this.#webhookReady) && this.service.snapshot().readiness; }

  async #runService(): Promise<void> {
    let primaryError: unknown;
    try {
      if (this.#webhook) {
        await this.#webhook.start();
        this.#webhookReady = true;
      }
      this.#installSignals();
      await this.service.start();
    } catch (error) {
      primaryError = error;
    }
    this.#removeSignals();
    try { await this.#closeWebhook(); }
    catch (error) { if (primaryError === undefined) throw error; }
    if (primaryError !== undefined) throw primaryError;
  }

  async #shutdownService(): ReturnType<OrchestratorService["shutdown"]> {
    this.#removeSignals();
    let closeError: unknown;
    try { await this.#closeWebhook(); }
    catch (error) { closeError = error; }
    const report = await this.service.shutdown();
    if (closeError !== undefined) throw closeError;
    return report;
  }

  #closeWebhook(): Promise<void> {
    this.#webhookReady = false;
    this.#webhookClose ??= this.#webhook?.close() ?? Promise.resolve();
    return this.#webhookClose;
  }

  #installSignals(): void {
    if (this.#signalsInstalled) return;
    let interruptInstalled = false;
    try {
      this.#signals.addListener("SIGINT", this.#interruptListener);
      interruptInstalled = true;
      this.#signals.addListener("SIGTERM", this.#terminateListener);
      this.#signalsInstalled = true;
    } catch (error) {
      if (interruptInstalled) this.#signals.removeListener("SIGINT", this.#interruptListener);
      throw error;
    }
  }

  #removeSignals(): void {
    if (!this.#signalsInstalled) return;
    this.#signalsInstalled = false;
    this.#signals.removeListener("SIGINT", this.#interruptListener);
    this.#signals.removeListener("SIGTERM", this.#terminateListener);
  }
}

export async function buildHostController(
  configuration: HostConfiguration,
  options: HostControllerOptions = {},
): Promise<HostController> {
  const environment = options.environment ?? process.env;
  const secrets = new HostSecretResolver(environment);
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
    const provider = createProvider(registration, repository, secrets, logger);
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
      `${provider.name}:${registration.id}`,
    );
    const engine = new ExecutionEngine(runtimes, workspaces, configurations, () => undefined, 100,
      () => new Date().toISOString(), logger);
    const scheduler = new Scheduler(provider, engine, { events: logger });
    let initial: Awaited<ReturnType<Scheduler["reloadConfiguration"]>> | undefined;
    try {
      initial = await scheduler.reloadConfiguration();
    } catch (error) {
      if (!(error instanceof ConfigurationReloadError)) throw error;
      // The service owns retrying an initially invalid repository configuration.
      // `ensemble validate` still reports this through HostController.validate().
    }
    repositories.push({ provider, configurations, scheduler });
    registrations.push({
      id: registration.id,
      scheduler,
      startupTimeoutMs: initial?.operationalPolicy.startupTimeoutMs ?? configuration.service.startupTimeoutMs,
      pollIntervalMs: initial?.operationalPolicy.pollIntervalMs ?? 30_000,
      drainTimeoutMs: initial?.operationalPolicy.drainTimeoutMs ?? 60_000,
      cancellationTimeoutMs: initial?.operationalPolicy.cancellationTimeoutMs ?? 10_000,
    });
  }
  const service = new OrchestratorService(registrations, ignoredServiceSignals, undefined, logger);
  const listener = configuration.service.webhooks;
  const webhook = listener ? new WebhookServer({
    host: listener.listenHost,
    port: listener.listenPort,
    publicBaseUrl: listener.publicBaseUrl,
    maxBodyBytes: listener.maxBodyBytes,
    requestTimeoutMs: listener.requestTimeoutMs,
    closeTimeoutMs: listener.closeTimeoutMs,
    routes: configuration.repositories.flatMap((registration) => registration.provider.type === "azure-devops"
      && registration.provider.webhook ? [{
        path: webhookPath(registration.provider.webhook.routeId),
        repositoryId: registration.id,
        username: secrets.resolve(registration.provider.webhook.username,
          `repositories.${registration.id}.provider.webhook.username`),
        password: secrets.resolve(registration.provider.webhook.password,
          `repositories.${registration.id}.provider.webhook.password`),
      }] : []),
    requestWake: (repositoryId) => { service.requestWake(repositoryId); },
    events: logger,
  }) : undefined;
  return new HostController(configuration, service, repositories, runtimes, secrets, webhook);
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
  const selectedEnvironment = runtimeEnvironment(runtime.environment.inherit, environment);
  const transport = new CodexAppServerTransport({ executable: runtime.executable, arguments: runtime.serverArguments,
    requestTimeoutMs: runtime.requestTimeoutMs, environment: selectedEnvironment });
  return new CodexRuntime(transport, undefined, undefined, undefined, undefined, runtime.name);
}

function createProvider(
  registration: HostConfiguration["repositories"][number],
  repository: { readonly id: string; readonly url: string; readonly defaultBranch?: string; readonly branch?: string },
  secrets: HostSecretResolver,
  operationalEvents: StructuredLogger,
): HostedProvider {
  const provider = registration.provider;
  if (provider.type === "vikunja") {
    return new VikunjaProvider({
      baseUrl: provider.baseUrl,
      token: secrets.resolve(provider.token, `repositories.${registration.id}.provider.token`),
      projectId: provider.projectId,
      viewId: provider.viewId,
      repository,
      requiredLabels: provider.requiredLabels,
      ...(provider.requiredAssignee ? { requiredAssignee: provider.requiredAssignee } : {}),
      ...(provider.statusLabels ? { statusLabels: provider.statusLabels } : {}),
      operationalEvents,
    });
  }
  return new AzureDevOpsProvider({
    organization: provider.organization,
    project: provider.project,
    pat: secrets.resolve(provider.pat, `repositories.${registration.id}.provider.pat`),
    queryId: provider.queryId,
    stateField: provider.stateField,
    nativeStates: provider.nativeStates,
    repository,
    requiredTags: provider.requiredTags,
    ...(provider.priorityField ? { priorityField: provider.priorityField } : {}),
    ...(provider.requiredAssignee ? { requiredAssignee: provider.requiredAssignee } : {}),
    ...(provider.blockerRelation ? { blockerRelation: provider.blockerRelation } : {}),
    ...(provider.acceptanceCriteriaField ? { acceptanceCriteriaField: provider.acceptanceCriteriaField } : {}),
    operationalEvents,
  });
}

function webhookPath(routeId: string): string {
  return `/webhooks/v1/repositories/${encodeURIComponent(routeId)}`;
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
