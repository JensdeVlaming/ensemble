# Approved plan: Ensemble specification architecture refactor

## Outcome

Resolve the five material gaps in `architecture-assessment.md` while preserving
the existing public abstractions where possible. Completion requires source and
test changes, both programmatic checks, and a requirement-by-requirement final
compliance report.

## Plan

### 1. Make provider execution state explicit and typed

- Add a portable `ProviderExecutionState` containing active execution, ordered
  history, and next role.
- Add `ProviderAdapter.getExecutionState(taskId)`; keep provider-specific storage
  mapping inside adapters.
- Require adapters to validate execution-state shape, sort history
  deterministically, and return immutable copies at this boundary.
- Update `InMemoryProvider` to implement the typed read without exposing its
  metadata encoding.
- Remove all `Task.metadata.activeExecution`, `nextRole`, and
  `executionHistory` interpretation from scheduler and execution engine.
- Preserve atomic/idempotent begin/complete/fail lifecycle methods. Remove the
  redundant `recordExecution` mutation; retain the granular status, comment,
  and artifact operations required by SPEC section 4, but orchestration uses
  only atomic lifecycle mutations for execution transitions.

Verification: recovery and idempotency tests assert through the typed provider
API, plus a provider whose task metadata contains unrelated/conflicting keys.

### 2. Restore the Scheduler/Execution Engine responsibility boundary

- Replace the monolithic task execution service with
  `ExecutionEngine.withEnvironment(task, callback)`. The engine allocates or
  restores the workspace, loads repository configuration, invokes the callback
  with a callback-scoped environment, and owns cleanup in one outer `finally`.
- Scheduler uses repository configuration and typed provider state to decide
  runnable policy and role, opens the durable execution, and supplies comments,
  artifacts, and role to the execution service.
- The callback-scoped environment exposes `run(request)` for one invocation.
  The engine uses its private workspace state to invoke the selected runtime,
  stream events, validate results, and cancel failures. It contains no role
  selection, retry policy, provider reads, or durable provider mutation.
- The engine releases the workspace after callback success or failure,
  including scheduler rejection, provider-read failure, `beginExecution`
  failure, and configuration-load failure. Allocation itself cleans any
  partially created workspace. An environment is single-use and closed after
  its callback; second use fails explicitly. It is never addressable by an
  external handle, eliminating unknown-handle behavior.

Verification: tests prove Scheduler chooses roles; cleanup occurs after
scheduler rejection, provider-read failure, and configuration failure; a
single-use environment rejects reuse; and a reconstructed scheduler restores
without hidden allocation state.

### 3. Add repository-defined bounded retry policy

- Extend repository configuration with `retry.maxFailedAttemptsPerRole`,
  defaulting to 3 and requiring a non-negative integer. This is a cap on total
  failed executions for a role; successful executions never consume it.
- For a task with no active execution, count all failed history records whose
  role equals the selected role. The role is `nextRole`, otherwise the most
  recent failed role, otherwise `initialRole`. It is eligible while that count
  is strictly less than the cap. Failures in other roles never consume this
  role's allowance. This cap is consulted only when history shows failed work
  for the selected role: an initial execution remains eligible under normal
  runnable-status policy even when the cap is `0`; `0` disables every retry.
- A durable active execution always runs first with its durable role, regardless
  of task status, configured runnable statuses, or exhausted retry allowance.
  It reuses the same durable provider execution ID rather than opening a new
  attempt, while launching a fresh ephemeral runtime session.
- Keep attempts/history in the provider; store no durable retry counters in
  Ensemble.
- Define `ProviderAdapter.discoverTasks({ scope: "workflow_candidates" })` as
  the pre-allocation boundary. The adapter maps provider-specific assignment,
  archive, and terminal-state concepts and returns only active workflow
  candidates plus any durable active executions. Scheduler then applies
  repository policy deterministically. This semantic query contains no
  provider names or status strings and prevents completed/irrelevant tasks from
  causing workspace allocation each poll. In-memory tests treat seeded tasks as
  the configured candidate set.
- Sort candidates by provider ID before scheduling so adapter return order
  cannot affect the deterministic result.

Verification: fail-then-succeed, restart-before-retry, per-role exhaustion, and
zero-cap tests; an active execution with a normally non-runnable status still
resumes; candidate-contract tests prove non-candidates cause no allocation.

### 4. Complete the Codex reference boundary

- Add `CodexCliTransport` behind the existing `CodexTransport` interface.
- Encapsulate argv construction, process lifecycle, JSONL decoding, session ID
  capture, final structured result extraction, resume, and cancellation inside
  `src/runtimes/codex/`.
- Inject the executable/process launcher for deterministic tests. Use argv
  arrays and no shell command strings. Do not hard-code credentials or a model.
- Normalize only documented/observed Codex transport records; unknown records
  remain safely ignorable and never leak to scheduler/engine parsing.

Verification: fake-process tests for start/event/result, malformed JSONL,
non-zero exit, resume argv, and cancellation. Consult current official Codex
documentation before locking invocation details; if the supported CLI cannot
provide a stable structured-result contract, keep the transport interface and
document that exact external boundary as a blocker rather than inventing flags.

### 5. Harden event/result failure behavior and document compliance

- Ensure event-stream rejection cannot hang execution or mask the primary
  runtime error; cancellation and cleanup remain best-effort and deterministic.
- Add focused tests only for behavior changed by this plan.
- Update README only where public construction or configuration changes.
- Write `compliance-report.md` mapping all material SPEC areas to final source
  and test evidence, noting honest limitations.
- Trace SPEC section 9 explicitly: Scheduler gathers provider comments and
  artifacts and selects the role; Engine transports the complete portable
  `RuntimeContext`; each Runtime alone constructs its own prompt/input.

## Migration and compatibility risks

- `ProviderAdapter` gains a required typed read method; test/provider adapters
  must implement it. This is an intentional v0.1 contract correction.
- The task execution service API changes to expose allocation/configuration
  without exposing runtime details. Since this repository is pre-release and
  has no production adapters, prefer architectural correctness over preserving
  the accidental API.
- Retry defaults change failed-task behavior. The cap and tests must prevent
  surprise infinite retries.
- Codex CLI flags/protocol are version-sensitive; official evidence and injected
  process tests are mandatory.

## Objective done state

- Scheduler alone selects runnable tasks, retries, and roles.
- Execution engine alone owns workspace allocation, runtime process handling,
  event streaming, cancellation, and cleanup.
- Provider adapter alone maps durable execution state.
- Codex details remain entirely inside the Codex runtime/transport.
- `npm test`, `npm run check`, required artifacts, and both judge rubrics pass
  with no unresolved in-scope issue.
