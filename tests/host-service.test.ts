import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostConfiguration } from "../src/host/configuration.ts";
import { buildHostController, HostController } from "../src/host/service.ts";
import { HostSecretResolver } from "../src/execution/repository.ts";
import { RuntimeRegistry } from "../src/runtimes/runtime.ts";
import type { OrchestratorShutdownReport, OrchestratorServiceState, ServiceSnapshot } from "../src/orchestration/service.ts";
import { AzureDevOpsProvider } from "../src/providers/azure-devops/adapter.ts";

test("host provider factory constructs the configured Azure DevOps Services provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-host-service-"));
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);
  const base = configuration();
  const controller = await buildHostController({
    ...base,
    service: { startupTimeoutMs: 30_000, stopTimeoutSeconds: 60 },
    workspace: { ...base.workspace, root: join(root, "workspaces") },
    repositories: [{
      id: "azure-repository",
      url: "https://example.test/azure-repository.git",
      configurationPath: repositoryPath,
      provider: {
        type: "azure-devops",
        organization: "example-org",
        project: "Example Project",
        pat: "$AZURE_DEVOPS_PAT",
        queryId: "query-id",
        stateField: "Custom.EnsembleState",
        nativeStates: { ready: "New", running: "Active", blocked: "Blocked", failed: "Failed", completed: "Closed" },
        priorityField: "Microsoft.VSTS.Common.Priority",
        requiredTags: ["ensemble"],
      },
    }],
  }, { environment: { AZURE_DEVOPS_PAT: "resolved-pat" }, writable: { write: () => true } });

  const provider = controller.repositories[0]?.provider;
  assert.ok(provider instanceof AzureDevOpsProvider);
  assert.equal(typeof controller.service.tick, "function");
  assert.equal(provider.client.baseUrl.toString(), "https://dev.azure.com/example-org/Example%20Project/");
  assert.deepEqual(provider.requiredTags, ["ensemble"]);
  assert.equal(provider.priorityField, "Microsoft.VSTS.Common.Priority");
});

test("host starts ingress before service and signal shutdown closes ingress first exactly once", async () => {
  const events: string[] = [];
  const serviceRun = deferred<void>();
  const service = new FakeService(events, serviceRun.promise);
  const ingress = {
    start: async () => { events.push("ingress.start"); return { endpoints: ["https://hooks.example.test/webhooks/v1/repositories/main"] }; },
    close: async () => { events.push("ingress.close"); },
  };
  const listeners = new Map<string, () => void>();
  const signals = {
    addListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => { listeners.set(signal, listener); },
    removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
  };
  const controller = new HostController(configuration(), service, [], new RuntimeRegistry(),
    new HostSecretResolver({}), ingress, signals);

  const running = controller.run();
  assert.equal(controller.readiness(), false);
  await turn();
  assert.deepEqual(events, ["ingress.start", "service.start"]);
  assert.equal(controller.readiness(), true);

  listeners.get("SIGTERM")?.();
  const shutdown = await controller.shutdown();
  serviceRun.resolve();
  await running;

  assert.deepEqual(shutdown, { repositories: [] });
  assert.deepEqual(events, ["ingress.start", "service.start", "ingress.close", "service.shutdown"]);
  assert.equal(controller.readiness(), false);
  assert.equal(listeners.size, 0);
  assert.strictEqual(controller.shutdown(), controller.shutdown());
});

test("host treats ingress bind failure as fatal and never starts the service", async () => {
  const events: string[] = [];
  const service = new FakeService(events, Promise.resolve());
  const ingress = {
    start: async () => { events.push("ingress.start"); throw new Error("address in use"); },
    close: async () => { events.push("ingress.close"); },
  };
  const controller = new HostController(configuration(), service, [], new RuntimeRegistry(),
    new HostSecretResolver({}), ingress, { addListener: () => undefined, removeListener: () => undefined });

  await assert.rejects(controller.run(), /address in use/u);
  assert.deepEqual(events, ["ingress.start", "ingress.close"]);
  assert.equal(controller.readiness(), false);
});

class FakeService {
  state: OrchestratorServiceState = "running";
  readonly #events: string[];
  readonly #run: Promise<void>;

  constructor(events: string[], run: Promise<void>) {
    this.#events = events;
    this.#run = run;
  }

  start(): Promise<void> {
    this.#events.push("service.start");
    return this.#run;
  }

  async shutdown(): Promise<OrchestratorShutdownReport> {
    this.#events.push("service.shutdown");
    this.state = "stopped";
    return { repositories: [] };
  }

  snapshot(): ServiceSnapshot {
    return {
      generatedAt: "2026-09-18T00:00:00.000Z",
      service: this.state === "idle" ? "starting" : this.state,
      readiness: this.state === "running",
      repositories: [],
      metrics: {},
    };
  }
}

function configuration(): HostConfiguration {
  return {
    version: 1,
    service: {
      startupTimeoutMs: 30_000,
      stopTimeoutSeconds: 60,
      webhooks: {
        publicBaseUrl: "https://hooks.example.test/",
        listenHost: "127.0.0.1",
        listenPort: 8_787,
        maxBodyBytes: 65_536,
        requestTimeoutMs: 10_000,
        closeTimeoutMs: 5_000,
      },
    },
    logging: { level: "info" },
    workspace: { root: "/tmp/ensemble", preserve: true, gitExecutable: "/usr/bin/git" },
    runtimes: [],
    repositories: [],
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
