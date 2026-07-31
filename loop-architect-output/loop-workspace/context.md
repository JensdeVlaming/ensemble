# Pre-change context baseline

Captured: 2026-07-31T08:37:12Z

Authoritative sources read before planning:

- `../../SPEC.md`
- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
- `../../tsconfig.json`
- every file under `../../src/` and `../../tests/`

## Baseline verification

- `npm test`: pass, 13 tests, 0 failures
- `npm run check`: pass, strict TypeScript project compilation

## Baseline source fingerprints

These hashes establish whether the delivery materially changes implementation
or tests without treating the loop's own artifacts as product progress.

| File | SHA-256 |
|---|---|
| `SPEC.md` | `d810ce6f7a4812976fe5999f9cff1b6290fd33e46275e895c8bd156291c1546d` |
| `AGENTS.md` | `47885af978eb8edfb54bee6806fa060974d91bd3737f36e5be64054993fcdf30` |
| `README.md` | `291b58564014f40b2060c3a932777a388612d89a5968ffbb269bee82f407595a` |
| `package.json` | `ca65c846c3e09f3d63da1a41d7eff6d8ae2bc045b9e8afaf1228a352158ac034` |
| `tsconfig.json` | `1ed7a59e19675f43ad838e9cfdac84af5049caa6b7069111365f370811e6641c` |
| `src/codex.ts` | `e3fd6ea7d19e85772b02154a69a1c7aa940fa75174fab02aa3eb8098af130615` |
| `src/engine.ts` | `b3fa2dc02d1994f7fa4e8fc32f37f38ec5b67b8f0bb5254d07cdc72688ea61e3` |
| `src/index.ts` | `94a77e1dd670ea22e5eb1a0da45e37e2fff8dd8b1ca8d3d341339c4fa2cef0d5` |
| `src/model.ts` | `b3814dc8155c7fcc4c1a0a89edf5d6ec5705fd55adaecef9bcb6fe8dc2e5fc51` |
| `src/provider.ts` | `8a0a9bd9a3897f7f059a1ffb8271d412b00349f066b9b825b840b2ae3031e97d` |
| `src/repository.ts` | `eb5681e9298a4f196c7c3d0cc79b8d00535a4882d571c45381ac3006469078f2` |
| `src/runtime.ts` | `e7cb0c45bed1e00fbf262cef6f9a9032f439287a292cc08676a251f86d3a1175` |
| `src/scheduler.ts` | `2cb91525cd2417668b98315a8f27c4fb5cae7f38834d7ef8e9d87138e8828b2a` |
| `src/testing.ts` | `f15bb598aafc6be59dda1fd34ad7050f93f6d069db1f9d3615f9e4fd1190fbff` |
| `src/workspace.ts` | `700cd1dd9057bd5853af6e00ce034195f1ffb518d5975520294b8f3fb5298d6b` |
| `tests/ensemble.test.ts` | `40b1eee03d21ba05d80b5f3e3d836d12f0f9fa563edfb78e0b57f72eeb0efca7` |

## Baseline architecture

- `Scheduler` discovers all provider-visible tasks and orders them by ID.
- `ExecutionEngine` currently allocates workspaces, loads configuration,
  determines role/runnability, opens provider executions, invokes runtimes,
  streams events, validates results, cancels failures, and cleans up.
- `ProviderAdapter` exposes both granular mutations and atomic execution
  lifecycle mutations. Portable execution state is stored in untyped
  `Task.metadata` keys interpreted outside the adapter.
- `RepositoryConfigLoader` reads repository-defined workflow, roles, runtime,
  and statuses.
- `Runtime` exposes prepare/start/resume/cancel and portable events/results.
- `CodexRuntime` owns prompt/event/result adaptation but depends on an injected
  transport; no concrete CLI transport is shipped.
- `LocalWorkspaceManager` and `GitRepositoryDriver` provide disposable or
  recoverable task workspaces and branch-aware clones.
