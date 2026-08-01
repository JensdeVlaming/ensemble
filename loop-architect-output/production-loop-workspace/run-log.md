# Production-readiness run log

## 2026-08-01 — initialization

- Resumed the existing Loop Architect target with a new production-readiness
  workspace, preserving the completed architecture-loop evidence.
- Compiled `loop.yaml` successfully with the skill-provided compiler.
- Confirmed the Git worktree was clean before loop artifact changes.
- Read `SPEC.md`, repository instructions, source/test layout, host/runtime/
  provider/workspace contracts, and current packaging metadata.
- Fetched the current official Codex manual and used its App Server JSON-RPC,
  thread/turn, approval/input/elicitation, dynamic-tool, usage, and rate-limit
  documentation for the transport plan. No secret-bearing files were sent.
- Drafted the assessment and six dependency-ordered delivery milestones.
- Next boundary: independent plan judge.

## 2026-08-01 — plan gate revision 1

- Baseline checks passed: 146 tests, strict TypeScript, production build, and
  diff integrity. The portable runner matches the skill template exactly.
- Independent judge verdict: `revise` with five blocking issues covering block
  resolution, execution/turn identities, workspace reconstruction ownership,
  restart-safe diagnostics, and workspace milestone isolation.
- Revised the plan with explicit durable block/resume, App Server continuation,
  provider diagnostic discovery, and workspace identity state machines.
- Split workspace work into identity/containment, refresh/hooks, and
  Scheduler-owned terminal cleanup milestones.
- Next boundary: independent plan judge revision 2.

## 2026-08-01 — plan gate revision 2

- Independent judge verdict: `revise` with one remaining blocker. All runtime,
  blocked-work, diagnostic reconstruction, boundary-ownership, and milestone-
  isolation blockers passed.
- Removed direct legacy workspace restoration. Added complete-or-partial
  provider task inventory, unique old-name matching, mandatory atomic migration
  to a hashed manifested path before runtime use, authoritative cleanup for
  complete inventory, and quarantine for partial, ambiguous, or unsafe entries.
- Next boundary: independent plan judge revision 3.

## 2026-08-01 — plan gate revision 3

- Independent judge confirmed the legacy migration safety semantics but rejected
  duplicated milestone dependencies and Scheduler knowledge of workspace names.
- Restricted milestone 4 to opaque workspace inventory, private matching,
  migration, containment, and manifest primitives with no provider dependency.
- Moved complete-or-partial provider inventory and all authoritative migrate,
  cleanup, or quarantine decisions into milestone 6. Scheduler supplies portable
  tasks but never sees legacy keys, paths, or the historical naming function.
- Next boundary: final allowed plan revision judge.

## 2026-08-01 — plan gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.99`.
- Approved plan contains eight independently judged implementation milestones.
- Baseline remains 146 passing tests plus clean typecheck/build/diff checks.
- Next boundary: commit loop/audit artifacts, then milestone 1 delivery.

## 2026-08-01 — milestone 1 delivery revision 1

- Committed approved loop/audit artifacts as `a820998`.
- Added portable host tool definitions, provider execution ID propagation, and
  approval/input/elicitation/usage/rate/heartbeat runtime events.
- Added bounded Engine blocking settlement and Scheduler-owned durable
  `blockExecution` synchronization with same-role provider resumption.
- Added strict portable payload and provider blocking-record validation.
- Tightened delivery during review: discriminated blocked reports, defensively
  frozen tool results, explicit block-policy enforcement, strict provider record
  validation, and lost-response synchronization repair.
- Verification passed: 152 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 1 delivery judge.

## 2026-08-01 — milestone 1 delivery revision 2

- Independent judge verdict: `revise` with four blockers covering exact
  untrusted-event normalization, blocking races, complete portable-tool
  validation, and restart-safe runtime-owned blocking policy.
- Added exact allowlisted normalization and bounded validation for every runtime
  event family and structured result. Untrusted fields and identifiers are never
  reflected in errors or operational logs.
- Made the first blocking request observable before event-sink delivery and in
  result-first, stream-first, cancellation, sink-failure, and bounded runtime-
  cancellation paths.
- Restricted portable tool schemas to a validated subset; validate inputs before
  invocation; clone/freeze inputs and results; enforce per-node, cumulative,
  count, depth, width, and byte budgets.
- Moved operator-request policy validation behind Runtime and before workspace
  allocation. Added the unresolved-block eligibility guard, lost-response
  repair coverage, and stale-block protection after a newer claim.
- Verification passed: 159 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 1 delivery judge revision 2.

## 2026-08-01 — milestone 1 delivery revision 3

- Independent judge verdict: `revise` with two remaining blockers: runtime
  policy validation was not atomic with repository revision installation, and
  durable blocking timestamps/records were not canonical and exact enough.
- Added a generic pre-install validator to reloadable configuration resolution.
  Execution Engine supplies the selected Runtime validator, while host validate,
  initial startup, zero-candidate startup, and hot reload all use the same
  Scheduler/Engine path. Invalid revisions now retain the last known good state.
- Canonicalized runtime timestamps before reports reach Scheduler/provider
  synchronization. Both provider adapters exact-normalize BlockingRequest and
  enforce that only a blocked record contains exactly one valid request.
- Added atomic reload-retention, offset timestamp, in-memory reconstruction, and
  Vikunja durable-history tests.
- Verification passed: 163 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 1 delivery judge revision 3.

## 2026-08-01 — milestone 1 delivery gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.99`.
- Judge confirmed atomic runtime-owned validation, canonical and exact durable
  blocking reconstruction, portable tool/event boundaries, race settlement,
  idempotency, architecture boundaries, and focused regression coverage.
- Next boundary: commit milestone 1, then begin Codex App Server milestone 2.

## 2026-08-01 — milestone 2 started

- Committed milestone 1 as `875f990` (`feat(runtime): add portable blocking and
  tool contracts`).
- Began the Codex App Server transport and continuation milestone using the
  current official JSON-RPC/thread/turn/server-request protocol reference.

## 2026-08-01 — milestone 2 delivery revision 1

- Added the bounded stdio JSON-RPC connection and App Server process transport.
- Added Runtime-owned corrective turns on one live thread with max-turn
  exhaustion, separate execution/thread/turn correlation, and cancellation.
- Added blocking request policies, dynamic portable tools, item lifecycle,
  usage/rate events, strict host registration, and retained CLI fallback.
- Verification passed: 171 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 2 delivery judge.

## 2026-08-01 — milestone 2 delivery revision 2

- Independent judge verdict: `revise` with six App Server interoperability
  blockers hidden by the initial fake fixtures.
- Generated the TypeScript protocol schema from the installed Codex App Server
  and aligned fixtures/implementation with its exact dynamic-tool, token-usage,
  rate-limit, delta, and permission-response shapes.
- Required thread and turn correlation on all scoped requests/events before tool
  invocation or blocking projection.
- Preserved resumable live threads during a bounded idle window and made the
  original max-turn budget non-resetting across corrective and explicit resume
  turns.
- Added payload-free heartbeat projection for agent/reasoning/command/file
  deltas and exact tests for official telemetry and permission denial.
- Verification passed: 172 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 2 delivery judge revision 2.

## 2026-08-01 — milestone 2 delivery revision 3

- Independent judge found one remaining official-protocol edge: MCP elicitation
  requires a thread correlation but may explicitly carry `turnId: null`.
- Elicitation now requires the turn field, accepts null as specified, and checks
  an exact active turn whenever a non-null ID is supplied. Other server requests
  continue to require exact non-null thread and turn IDs.
- Focused App Server tests, typecheck, and diff integrity pass.
- Next boundary: final milestone 2 delivery judge.

## 2026-08-01 — milestone 2 delivery gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.99`.
- Judge confirmed current official App Server interoperability, strict
  correlations, continuation budgets, request policies, dynamic tools,
  telemetry, activity, cancellation, and host/runtime boundaries.
- Next boundary: commit milestone 2, then begin Vikunja-native tool milestone 3.

## 2026-08-01 — milestone 3 started

- Committed milestone 2 as `b0f82f3` (`feat(codex): add app server
  transport`).
- Began task-scoped provider capability discovery and credential-safe Vikunja
  read/comment tools.

## 2026-08-01 — milestone 3 delivery revision 1

- Added claim-scoped Vikunja task, comment, and artifact reads plus idempotent
  comment writes with provider-durable restart recovery.
- Bounded and redacted every tool boundary and omitted provider/artifact
  metadata from portable results.
- Verification passed: 174 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 3 delivery judge.

## 2026-08-01 — milestone 3 delivery revision 2

- Independent judge requested App Server-compatible names, cross-instance
  comment idempotency, and aggregate result bounds.
- Replaced dotted names with portable function identifiers, added lease-owner
  revocation and provider-side duplicate reconciliation using Vikunja's comment
  deletion endpoint, and enforced a serialized aggregate output budget.
- Added focused overlap, takeover, function-name, and aggregate-size coverage.
- Full verification passed: 176 tests, typecheck, production build, diff
  integrity.
- Next boundary: independent milestone 3 re-review.

## 2026-08-01 — milestone 3 delivery gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.98`.
- Judge confirmed App Server-safe identifiers, execution and lease-owner scope,
  cross-instance duplicate reconciliation, and aggregate portable output bounds.
- Next boundary: commit milestone 3, then begin workspace identity and
  containment milestone 4.

## 2026-08-01 — milestone 4 started

- Committed milestone 3 as `fa26c6f` (`feat(vikunja): add credential-safe agent
  tools`).
- Began collision-safe workspace identity, manifests, legacy classification,
  and containment hardening.

## 2026-08-01 — milestone 4 delivery revision 1

- Added namespaced hashed paths, strict identity manifests, opaque legacy
  classification/migration, and containment revalidation before runtime use.
- Verification passed: 181 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 4 delivery judge.

## 2026-08-01 — milestone 4 delivery revision 2

- Independent judge identified tautological final manifest validation and
  pathname-only TOCTOU gaps for the base root, workspaces, legacy handles, and
  cleanup.
- The manager now retains the allocation's expected manifest, pins base,
  workspace, and legacy device/inode identities, validates ownership and
  non-writable directory boundaries, and rejects replacements at every public
  action and before/after filesystem transitions.
- Verification passed: 182 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 4 re-review.

## 2026-08-01 — milestone 4 delivery revision 3

- Independent judge requested identity pinning for repository/runtime directory
  entries and safe configured-root ownership/modes.
- Workspace registrations now pin and recheck all three component identities;
  existing bases must be owned by the service user and reject group/other write
  access on every boundary check.
- Verification passed: 183 tests, typecheck, production build, diff integrity.
- Next boundary: final milestone 4 delivery judge.

## 2026-08-01 — milestone 4 delivery gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.99`.
- Judge confirmed complete component identity pinning, immutable manifest
  validation, safe configured-root ownership/modes, opaque legacy operations,
  and practical Node.js containment guarantees.
- Next boundary: commit milestone 4, then begin repository refresh and lifecycle
  hooks milestone 5.

## 2026-08-01 — milestone 5 started

- Committed milestone 4 as `19adf61` (`fix(workspace): harden identity and
  containment`).
- Began repository identity/refresh policy and bounded lifecycle hooks.

## 2026-08-01 — milestone 5 delivery revision 1

- Added identity-verified bounded Git refresh preserving local work and complete
  argv-only lifecycle hook execution with explicit failure precedence.
- Verification passed: 189 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 5 delivery judge.

## 2026-08-01 — milestone 5 delivery revision 2

- Independent judge found that timeout paths released child ownership before
  confirmed exit and that terminal failure lifecycle coverage was incomplete.
- Unified Git and hook execution behind one bounded argv-only process runner
  that waits for child close or a final bounded fallback after forced
  termination.
- Added exact lifecycle coverage for runtime start failure, runtime result
  failure, blocked work, and cancellation, including primary-error precedence
  and exactly-once `afterRun`/`beforeRemove` behavior.
- Verification passed: 193 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 5 re-review.

## 2026-08-01 — milestone 5 delivery revision 3

- Independent judge found that direct-child termination did not cover spawned
  descendants and requested explicit blocked/cancelled secondary-failure tests.
- Bounded processes now own a POSIX process group, kill and confirm the whole
  group, reject successful parents that leave background descendants, and
  surface a typed unconfirmed-termination condition after the final bound.
- The engine and workspace manager stop later destructive transitions whenever
  process-tree termination cannot be confirmed. Focused tests prove descendant
  removal, deletion suppression, and blocked/cancelled result precedence when
  both terminal hooks fail.
- Verification passed: 194 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 5 final review.

## 2026-08-01 — milestone 5 delivery revision 4

- Independent judge found that unconfirmed termination from `afterCreate` or
  `beforeRun` could still flow into later hooks and deletion.
- The engine now carries the unsafe-termination state across allocation and
  runtime-start boundaries, suppressing all subsequent hooks and cleanup for
  those paths. Focused tests cover all four lifecycle hook positions.
- Verification passed: 194 tests, typecheck, production build, diff integrity.
- Next boundary: independent milestone 5 final re-review.

## 2026-08-01 — milestone 5 delivery gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.99`.
- Judge confirmed bounded process-tree ownership, destructive-transition
  suppression for every unconfirmed hook stage, lifecycle ordering, and
  primary-result precedence across all terminal paths.
- Next boundary: commit milestone 5, then begin Scheduler-owned terminal and
  startup cleanup milestone 6.

## 2026-08-01 — milestone 6 delivery revision 1

- Committed milestone 5 as `3cfd773` (`feat(workspace): add refresh and
  lifecycle hooks`).
- Added complete/partial portable provider inventory, Vikunja terminal/archive
  inventory, opaque legacy/managed workspace classification, Scheduler-owned
  startup/tick decisions, forced terminal cleanup, and restart-safe quarantine.
- Added active-execution retention and attempt-cleanup ordering so terminal
  deletion cannot overlap a live runtime or `afterRun`.
- Verification passed: 201 tests and typecheck.
- Next boundary: build/diff verification and independent milestone 6 judge.

## 2026-08-01 — milestone 6 delivery revision 2

- Independent judge required exact retention for unmatched workspaces under a
  partial inventory and containment validation before legacy hooks.
- Partial inventory now leaves unmatched legacy and managed workspaces wholly
  untouched; only independently ambiguous or invalid entries are quarantined.
- Legacy removal validates the repository/runtime shape immediately before a
  repository-scoped hook and skips the hook when that shape is unsafe while
  retaining identity-pinned root deletion.
- Added a symlink escape regression test.
- Next boundary: full verification and final milestone 6 re-review.

## 2026-08-01 — milestone 6 delivery gate passed

- Independent judge verdict: `pass`, no blocking issues, confidence `0.99`.
- Judge confirmed exact partial-inventory retention, independent quarantine of
  ambiguous/invalid workspaces, legacy hook containment, and the symlink escape
  regression.
- Final verification passed: 202 tests, typecheck, production build, and diff
  integrity.
- Work stops after the milestone 6 commit by operator request. Milestones 7 and
  8 are documented in `handoff-after-milestone-6.md`.
