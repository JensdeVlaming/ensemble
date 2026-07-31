# Ensemble

Ensemble is a small, runtime- and provider-independent orchestration core for
autonomous software engineering agents. The task provider owns workflow state;
Ensemble retains only ephemeral process and workspace state.

## Requirements

- Node.js 22.6 or newer (the implementation uses Node's type stripping)

## Run the tests

```sh
npm install
npm test
npm run check
```

## Architecture

```text
src/
├── domain/                 portable data contracts
├── providers/
│   ├── provider.ts         provider adapter contract
│   └── memory/             reference adapter
├── orchestration/          deterministic scheduling policy
├── execution/              workspace and runtime lifecycle
└── runtimes/
    ├── runtime.ts          common runtime contract
    ├── scripted/           test/reference runtime
    └── codex/              Codex runtime and CLI transport
```

- `Scheduler` polls semantic workflow candidates, deterministically orders them,
  resolves repository-defined roles, applies per-role retry policy, and owns all
  durable provider transitions.
- `ExecutionEngine` owns callback-scoped disposable workspaces, configuration
  loading, runtime invocation, event streaming, cancellation, and cleanup. It
  contains no provider or scheduling policy.
- `Runtime` turns a complete `RuntimeContext` into a session of portable events
  and a structured result.
- `ProviderAdapter` is the only layer that understands an external task system.
- `RepositoryConfigLoader` reads `.ensemble/config.yaml`, `WORKFLOW.md`, role
  files, and `AGENTS.md`.

The stable public API is re-exported from `src/index.ts`. `InMemoryProvider` and
`ScriptedRuntime` are executable reference adapters suitable for tests and local
experiments. `GitRepositoryDriver` materializes isolated repository checkouts;
`CodexRuntime` contains Codex-specific context, prompt, event, and result handling.
`CodexCliTransport` is the concrete process-backed reference transport for the
documented `codex exec --json` and `codex exec resume` protocol; its process
launcher is injectable for deterministic tests.

Provider adapters expose durable execution history through
`getExecutionState`. `discoverTasks({ scope: "workflow_candidates" })` means the
adapter applies provider-specific assignment, archive, and terminal filters
before the Scheduler allocates a workspace. Production provider adapters are
deliberately outside this repository's scope.

## Repository retry policy

Retry behavior is repository-owned:

```yaml
retry:
  maxFailedAttemptsPerRole: 3
```

The value counts failed executions separately for each role. It defaults to
`3`; `0` still permits a task's initial execution but disables retries. Durable
active executions always recover with their provider-stored role and execution
ID, regardless of status or retry exhaustion.

## Codex transport

Construct the reference runtime with `new CodexRuntime(new CodexCliTransport())`.
The transport uses argv arrays (never a shell command), does not embed a model or
credentials, normalizes documented command events, extracts the final structured
JSON result, supports resume by Codex thread ID, and cancels the child process.
Authentication remains deployment configuration. A repository may select a
model through `runtime.config.model`; the transport validates it and emits the
documented `--model` argv pair without hard-coding any model name.
