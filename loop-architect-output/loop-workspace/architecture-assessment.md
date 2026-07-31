# Ensemble architecture assessment

## Executive judgment

The implementation is a sound executable skeleton and its existing tests cover
several important recovery paths. It does not yet fully conform to the component
responsibilities in `SPEC.md`: scheduling decisions leak into the execution
engine, portable provider workflow state is encoded as untyped metadata, retry
behavior is not bounded or repository-defined, and the named Codex reference
runtime has no concrete CLI transport.

## Requirement traceability

| SPEC area | Current evidence | Finding and disposition |
|---|---|---|
| 2.1 Provider is source of truth | `ProviderAdapter.beginExecution`, `completeExecution`, and `failExecution`; recovery tests | Partially conforming. Durable execution state lives in the provider, but scheduler/engine interpret undocumented `Task.metadata.activeExecution`, `nextRole`, and `executionHistory`. Add a typed provider execution-state read contract so adapters own the mapping. |
| 2.2 Repository defines execution | `RepositoryConfigLoader`, `.ensemble/config.yaml`, workflow and role files | Conforming for the supported configuration subset. Extend repository config only for an explicit bounded retry policy. |
| 2.3 Runtime independence | `Runtime`, `RuntimeRegistry`; scheduler imports no Codex types | Conforming. Preserve this boundary. |
| 2.4 Provider independence | Orchestration depends on `ProviderAdapter` | Mostly conforming. Remove direct interpretation of provider metadata outside the adapter. Do not add a production adapter. |
| 2.5 Ephemeral runtime state | Scheduler `#active`, Codex session map, disposable workspaces | Conforming if fresh allocation/session reconstruction remains possible. Add tests proving the refactor does not depend on allocation memory after restart. |
| 3 High-level flow | Provider -> Scheduler -> execution service -> runtime | Partially conforming. Execution engine currently determines runnable policy and role, responsibilities assigned to Scheduler. |
| 4 Scheduler | Deterministic ID sort, polling, provider transitions | Missing a clean ownership of role/runnability and bounded failed-work retry. Move those decisions to Scheduler and add repository-defined retry limits. |
| 4 Execution Engine | Workspace allocation/config loading/runtime invocation/event streaming/cancellation/cleanup | Strong lifecycle coverage, but it also reads provider comments/artifacts, opens durable executions, and selects roles. Narrow it to where/how execution occurs behind an opaque allocation. |
| 4 Provider Adapter | Discovery, reads, status/comments/artifacts plus atomic lifecycle | Conforming capability set, with redundant granular and lifecycle mutation surfaces. Keep granular methods for the spec-facing adapter contract, but require orchestration to use the atomic lifecycle operations. |
| 5-8 repository instructions and roles | Repository layout and loader tests | Conforming. |
| 9-11 runtime/context | Common interfaces and complete context | Conforming. Ensure scheduler supplies provider context and engine only passes it to the selected runtime. |
| 12 runtime events | Portable discriminated union and engine event sink | Conforming abstraction. Add a failure test for an event-stream error racing a result. |
| 13 Codex runtime | Context, prompt, event, and result builders; injected transport | Partially conforming. The specified Codex CLI stage is absent. Add a concrete process-backed transport behind `CodexTransport`, with JSONL parsing isolated in `src/codex.ts` and no Codex knowledge elsewhere. |
| 14 structured result | Generic and Codex validation; scheduler semantic transition validation | Conforming. Preserve pre-synchronization validation and add whitespace/invalid artifact checks if touched. |
| 15 reconstruction | Durable active execution and next-role tests | Partially conforming. Recovery works, but through untyped metadata and without bounded retry state. Test typed state recovery and retry exhaustion. |
| 16 workspace | Isolated layout, clone/branch, restore and cleanup tests | Conforming. Preserve engine ownership and cleanup on allocation/config/runtime failures. |
| 17 configuration/secrets | `.ensemble` config contains no secrets | Conforming. Retry configuration must contain policy only, never credentials. |
| 18 extensibility | Registries/interfaces support replacement | Conforming in principle. The refactor must not add runtime/provider conditionals. |
| 19 design philosophy | Core coordinates provider tasks into runtime execution | Conforming scope. Production providers, deployment, UI, and unrelated features remain excluded. |

## Material gaps

1. Scheduler does not own all “what runs” decisions; `inferRole` and runnable
   checks live in `ExecutionEngine`.
2. Provider-owned execution state has no typed read API. Orchestration relies on
   magic metadata keys, weakening provider independence and reconstruction.
3. Failed-work retry is neither explicit nor bounded. A failed status only runs
   if manually included among runnable statuses, which can retry forever.
4. No concrete Codex CLI transport completes the reference runtime pipeline.
5. Event-stream failure and retry-exhaustion behavior are not directly tested.

## Excluded findings

- No production Vikunja, ClickUp, GitHub Issues, or Linear adapters.
- No deployment, secret manager, queue, daemon, UI, PR, or CI implementation.
- No full YAML implementation unless required by an approved in-scope change.
- No ownership of source-control or project-management state beyond interfaces.
