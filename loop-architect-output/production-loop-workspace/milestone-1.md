# Milestone 1 delivery — portable tools, events, and blocked executions

## Delivered contracts

- `RuntimeContext` now carries the durable provider `executionId` and immutable
  host-executed `RuntimeTool` capabilities.
- Portable tools validate names, descriptions, plain JSON input schemas, schema
  subset, invocation input, per-value and aggregate size/depth/width/node limits,
  uniqueness, invocation presence, and JSON-safe bounded results. Inputs and
  results are cloned and deeply frozen. The Codex context builder serializes
  only name, description, and schema; invocation closures stay on the host.
- Every `RuntimeEvent` carries the provider execution ID. Added approval,
  user-input, tool-elicitation, usage, rate-limit, and heartbeat variants.
- Execution Engine exact-normalizes every event family and structured result,
  rejecting unknown discriminants, undeclared fields, malformed artifacts,
  over-sized values, and identity mismatches without echoing untrusted values.
  Runtime session/thread IDs remain diagnostic values only.
- Operator policy is validated by the selected Runtime before workspace
  allocation and atomically before a repository revision is installed. CLI
  validation, zero-candidate startup, and hot reload therefore retain the last
  known good revision on invalid runtime policy. An unresolved operator event
  is accepted only when that Runtime has explicitly prepared the run with
  `operatorRequests: block`.

## Blocked-work state machine

- The first valid blocking event settles a `RunningExecution` as `blocked` after
  bounded runtime cancellation. Detached result/event promises remain observed
  and attempt cleanup remains best-effort. Blocking is captured before the event
  sink, remains visible after an early result, and has deterministic precedence
  relative to cancellation based on which signal is observed first.
- The blocked report is distinct from a structured runtime completion result.
- Scheduler persists an immutable execution record with outcome `blocked`, the
  portable request, and `nextRole` equal to the interrupted role via
  `ProviderAdapter.blockExecution` while holding the lease.
- Provider state moves to the configured blocked status and clears its active
  marker. Provider-side movement back to runnable state causes the same role to
  receive a new execution ID; blocking history remains immutable.
- An unresolved blocking record remains ineligible even if the configured
  blocked status is also listed as runnable. A duplicate stale block cannot
  clear or relabel a newer active claim.
- Provider adapters now strictly validate blocking kinds, timestamps, IDs, and
  bounded summaries when reconstructing durable state. Runtime timestamps are
  canonicalized before synchronization; both adapters exact-normalize blocking
  requests and reject blocked records without a request or non-blocked records
  that carry one.

## Focused evidence

`tests/runtime-blocking.test.ts` verifies:

- tool immutability, schema/result rejection, invocation closure isolation, and
  prompt-safe definition projection, including invalid input, unsupported
  schema, collection/aggregate budgets, and post-return mutation;
- bounded cancellation and blocked live-handle diagnostics;
- rejection when a runtime substitutes a session/thread ID for the provider
  execution ID;
- exact rejection for undeclared secret-bearing fields across every event
  family, unknown/oversized events, malformed artifacts/results, and nested
  blocking-request fields without reflecting secret sentinels;
- result/block, sink/block, multiple-block, external-cancellation, rejection,
  and hanging-cancellation races;
- missing and invalid runtime-owned block policy before workspace allocation;
- atomic runtime validation across reload with last-known-good retention;
- restart while blocked, provider-visible resolution, same-role selection, a
  new durable claim ID, and preservation of the old blocking record.
- repair after the provider durably records a block but its response is lost,
  proving idempotent synchronization completes before redispatch; and stale
  block rejection after a newer claim.

Existing logging tests cover usage/rate/heartbeat event projection without raw
payloads. Existing Vikunja tests continue to cover idempotent durable blocking
and restart reconstruction.

## Verification

- `npm test`: 163 passed, 0 failed.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Scope boundary

No provider-native tools are registered yet and Codex CLI cannot originate
interactive request events. Those protocol-specific paths are milestones 2 and
3; this delivery establishes and verifies the portable control plane they use.
