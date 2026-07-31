# Ensemble specification compliance report

## Result

The in-scope Ensemble core conforms to `SPEC.md`. The refactor restores the
Scheduler/Execution Engine boundary, makes provider-owned execution state a
typed adapter contract, adds repository-defined bounded retry, and completes the
Codex reference pipeline with a process-backed transport. Production provider
adapters, deployment infrastructure, UI, and unrelated features remain excluded
as required by the approved scope.

## Requirement evidence

| SPEC area | Final implementation evidence | Verification evidence | Status |
|---|---|---|---|
| 2.1 Provider source of truth | `src/providers/provider.ts` defines typed durable execution state and atomic lifecycle operations. `src/providers/memory/adapter.ts` validates, orders, copies, and freezes adapter state. Scheduler reads only this contract in `src/orchestration/scheduler.ts`; it stores no durable counters. | `tests/architecture.test.ts:81` proves task metadata cannot override adapter state and malformed state is rejected. Existing recovery/idempotency tests use the typed API. | Conforming |
| 2.2 Repository defines execution | `src/execution/repository.ts` loads runtime, roles, statuses, and retry policy from `.ensemble`; `src/domain/model.ts` carries the resulting portable configuration. | `tests/ensemble.test.ts` covers repository configuration and custom statuses; `tests/architecture.test.ts:101-127,211-218` covers repository retry values and validation. | Conforming |
| 2.3 Runtime independence | `src/runtimes/runtime.ts` retains the common Runtime interface and registry. `src/execution/engine.ts` invokes only that interface; Scheduler imports no runtime implementation. | Scripted and Codex runtime tests exercise the same engine-facing abstraction. | Conforming |
| 2.4 Provider independence | `src/providers/provider.ts` is provider-neutral. `TaskQuery.scope = workflow_candidates` assigns provider-specific assignment/archive/terminal mapping to adapters before allocation. No provider names occur in Scheduler or Engine. | `tests/architecture.test.ts:196-209` proves non-candidates cause no workspace allocation. | Conforming |
| 2.5 Ephemeral runtime state | `src/execution/engine.ts` creates/restores a callback-scoped environment and cleans it; `src/orchestration/scheduler.ts` keeps only an in-process duplicate-run guard. Durable role, execution ID, history, and transitions remain in ProviderAdapter. | Recovery creates a fresh Scheduler/Runtime while reusing provider execution ID in `tests/ensemble.test.ts` and `tests/architecture.test.ts:129-137`. | Conforming |
| 3-4 component flow and ownership | `src/orchestration/scheduler.ts` owns discovery, ordering, eligibility, role choice, retries, begin/complete/fail. `src/execution/engine.ts` owns workspace/configuration lifecycle, runtime invocation, events, cancellation, and cleanup, with no ProviderAdapter dependency. | `tests/architecture.test.ts:139-172` covers rejection/config/provider-read cleanup and the environment capability boundary. | Conforming |
| 5-8 repository layout, AGENTS, WORKFLOW, roles | `src/execution/repository.ts` reads `AGENTS.md`, `.ensemble/WORKFLOW.md`, config, and sorted role files and rejects missing roles/invalid initial roles. | Repository fixture and loader assertions in `tests/ensemble.test.ts`. | Conforming |
| 9-11 Runtime ownership/context | Scheduler gathers provider comments/artifacts and chooses the role in `src/orchestration/scheduler.ts`. Engine supplies the complete portable context in `src/execution/engine.ts`. Each Runtime prepares its own input; Codex builders remain in `src/runtimes/codex/runtime.ts`. | Codex context/prompt ownership assertions in `tests/ensemble.test.ts`; ScriptedRuntime contexts verify selected roles. | Conforming |
| 12 portable events | `src/runtimes/runtime.ts` defines the runtime-independent event union. Engine alone consumes the stream. On event failure it cancels and performs a bounded result-channel drain, preserving a runtime error surfaced by cancellation without allowing a broken result channel to hang execution. Codex records are normalized inside `src/runtimes/codex/cli-transport.ts`. | Architecture tests prove cancellation-time runtime-error precedence and that stream failure cannot hang a permanently pending result. | Conforming |
| 13 Codex reference runtime | `src/runtimes/codex/runtime.ts` contains Context Builder, Prompt Builder, Event Parser, Result Builder, and Runtime, with WeakMap session associations. `src/runtimes/codex/cli-transport.ts` implements argv-only `codex exec --json`, validated repository model configuration, JSONL decoding, documented thread IDs, final structured extraction, resume, cancellation, and injected process launching. No Codex type leaks into Scheduler/Engine. | `tests/codex-cli.test.ts` covers configured model argv, normalized events, result, resume argv/working directory, malformed JSONL, non-zero exit, and cancellation. Invocation behavior was verified against the current official Codex manual before implementation. | Conforming |
| 14 structured results | `src/execution/engine.ts` validates portable results including nonblank fields/artifacts. `src/orchestration/scheduler.ts` validates semantic role transitions before atomic provider synchronization. Codex result validation remains runtime-local. | Invalid transition and Codex parsing tests in `tests/ensemble.test.ts`; failure paths are durably recorded. | Conforming |
| 15 state reconstruction | Active state takes unconditional precedence in `src/orchestration/scheduler.ts`, reuses its provider execution ID, and invokes a fresh runtime in the restored workspace. Failed retry counts are reconstructed from provider history. | `tests/architecture.test.ts:101-137` covers restart-safe retry bounds, per-role isolation, zero cap, and active recovery under a non-runnable status. | Conforming |
| 16 workspace isolation | `src/execution/workspace.ts` materializes isolated task paths, restores them, removes partial creation failures, and applies configured cleanup. Engine owns cleanup for every callback path. | Workspace integration tests plus `tests/architecture.test.ts:139-172`. | Conforming |
| 17 configuration/secrets | Repository config contains policy and runtime selection only. `CodexCliTransport` embeds neither credentials nor a model; deployment/environment supplies authentication. | Constructor/argv assertions in `tests/codex-cli.test.ts`. | Conforming |
| 18 extensibility | ProviderAdapter, Runtime, RepositoryConfigSource, RepositoryDriver, WorkspaceManager, and process launcher remain replaceable interfaces. | Tests inject alternate providers, runtimes, workspace managers, repository drivers, and Codex launchers. | Conforming |
| 19 design philosophy | Core code coordinates provider-visible tasks into runtime executions and does not implement project management, CI, deployment, UI, or production integrations. | Source inventory and scoped change review show no excluded feature was added. | Conforming |

## Approved-plan traceability

1. Typed provider state: `src/providers/`, provider-state and reconstruction tests.
2. Scheduler/Engine boundary: `src/orchestration/`, `src/execution/`, lifecycle tests.
3. Bounded retry: `src/domain/model.ts`, `src/execution/repository.ts`, per-role/zero/exhaustion tests.
4. Codex CLI boundary: `src/runtimes/codex/`, fake-process transport tests.
5. Failure hardening and documentation: event-race tests and `README.md`.

## Verification

- `npm test`: 26 tests passed, 0 failed, including reconstructed-Scheduler
  retry, in-callback second-use rejection, and full provider-state edge checks.
- `npm run check`: strict TypeScript compilation passed.
- Required architecture assessment, approved plan, and this report are present
  and non-empty.

## Scope statement

No production provider adapter, deployment infrastructure, UI, PR, commit,
push, or deployment was created. `InMemoryProvider`, `ScriptedRuntime`, and the
injectable Codex process launcher are reference/testing components only.
