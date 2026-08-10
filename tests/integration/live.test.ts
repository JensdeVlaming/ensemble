import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VikunjaProvider } from "../../src/providers/vikunja/adapter.ts";
import { CodexAppServerTransport } from "../../src/runtimes/codex/app-server-transport.ts";

const enabled = process.env.ENSEMBLE_INTEGRATION === "1";

test("live Vikunja configuration matches the deployed API", { skip: !enabled || !process.env.ENSEMBLE_VIKUNJA_BASE_URL || !process.env.ENSEMBLE_VIKUNJA_TOKEN
  || !process.env.ENSEMBLE_VIKUNJA_PROJECT_ID || !process.env.ENSEMBLE_VIKUNJA_VIEW_ID }, async () => {
  const provider = new VikunjaProvider({
    baseUrl: required("ENSEMBLE_VIKUNJA_BASE_URL"),
    token: required("ENSEMBLE_VIKUNJA_TOKEN"),
    projectId: number("ENSEMBLE_VIKUNJA_PROJECT_ID"),
    viewId: number("ENSEMBLE_VIKUNJA_VIEW_ID"),
    repository: { id: "integration", url: "https://example.invalid/integration.git" },
    requiredLabels: [],
  });
  await provider.validateConfiguration();
  assert.equal(provider.name, "vikunja");
});

test("live Codex App Server completes initialize and account handshake", { skip: !enabled || !process.env.ENSEMBLE_CODEX_EXECUTABLE }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ensemble-integration-"));
  try {
    const transport = new CodexAppServerTransport({ executable: required("ENSEMBLE_CODEX_EXECUTABLE"), requestTimeoutMs: 15_000,
      environment: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    await transport.diagnose(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function number(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
