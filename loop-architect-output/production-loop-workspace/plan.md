# Production-readiness milestone plan — revision 4

## Delivery rules

Each milestone starts from a clean committed parent, adds focused tests for its
success and failure boundaries, runs `npm test`, `npm run check`, `npm run build`,
and `git diff --check`, receives a fenced JSON verdict from the independent
read-only judge, resolves every blocking issue within three revisions, and is
then committed using a conventional commit message. No milestone may depend on
uncommitted behavior from a later milestone.

## Cross-milestone durable state machines

### Block, resolution, and resume

A runtime operator request terminates one provider execution with outcome
`blocked`, a portable `BlockingRequest`, and `nextRole` equal to the interrupted
role. The Scheduler cancels the ephemeral session within the existing bound,
then idempotently calls `blockExecution`; the provider applies the configured
blocked status and clears the active marker. While the current normalized task
status is blocked or the adapter reports it non-dispatchable, the request is
unresolved and no claim occurs, including after restart.

Resolution is an explicit provider-side action: the operator answers in a
provider-visible comment/field as supported by the adapter, removes the blocked
status, and moves the task to a configured runnable status. The adapter then
returns it as a workflow candidate. The persisted `nextRole` selects the
interrupted role, and `beginExecution` creates a new execution ID; the old
blocking record remains immutable history. Eligibility of current task state,
not deletion of history, distinguishes resolution. Restart before resolution
reconstructs a blocked diagnostic only; restart after resolution produces the
same new claim decision as an uninterrupted Scheduler. Repeating the old block
mutation is idempotent and cannot overwrite the new execution.

### Execution and runtime identities

`RuntimeContext.executionId` is always the provider claim ID. The Execution
Engine copies it from `RuntimeExecutionRequest` and validates that every
portable event carries exactly that ID. Runtimes add this durable correlation
when translating their protocol; Codex thread/session/turn IDs remain separate
diagnostic fields and can never replace it. A mismatch is a runtime protocol
failure and causes bounded cancellation.

### App Server continuation

`CodexRuntime` owns continuation policy. A transport turn yields notifications
plus the final agent message. The result builder parses that message as the
portable structured result. If it is absent or invalid but the turn completed
normally, the runtime starts a corrective continuation turn on the same thread,
including only bounded validation feedback; a valid result ends the session.
Explicit runtime `resume` also adds newly read provider context as a new turn on
the same live thread. `maxTurns` counts initial, corrective, and resume turns.
Exhaustion interrupts the active turn if necessary and rejects with a typed
runtime error, which Scheduler classifies under current retry policy. A process
restart creates a fresh App Server thread with the same active provider
execution ID during recovery; no hidden thread ID is required.

### Durable operational diagnostics

`TaskQuery.scope` gains a provider-neutral `workflow_diagnostics` scope. An
adapter returns bounded current tasks that have provider-owned active, latest
retryable-failure, or latest unresolved-blocking state. It determines this using
its own durable representation; no external component reads provider metadata.
Scheduler reads the portable `ProviderExecutionState`, treats a latest blocking
record as unresolved only while current state remains blocked/ineligible, and
rebuilds retry due records from persisted `failure.nextAttemptAt`. This query is
used at startup and snapshot publication, so blocked and retrying diagnostics
survive restart. Partial or unreadable diagnostics retain the last immutable
snapshot and emit degradation rather than inventing deletion or eligibility.

## Milestone 1 — portable tools, operational events, and blocked executions

1. Add immutable JSON-schema-based portable tool definitions and host invocation
   capabilities plus `executionId` to `RuntimeContext`. Invocation closures are
   deliberately omitted by Codex context/prompt serialization and logs.
2. Add execution-ID-bearing portable event variants for approvals, user input,
   tool elicitation, usage, rate limits, and heartbeat. Validate correlations
   and bounded payloads and explicitly classify activity-bearing variants.
3. Extend the live execution report with a blocked outcome. The first unresolved
   request wins, causes bounded runtime cancellation, settles local ownership,
   and returns a portable request while late result/event channels stay observed.
4. Persist the block state machine above through `ProviderAdapter.blockExecution`
   without failure/retry classification. Validate operator policy and blocked
   status requirements.
5. Test execution-ID mismatch, block/cancel races, block synchronization retry,
   duplicate block, restart while blocked, provider-side resolution, same-role
   new-ID claim, and restart after resolution.

Commit: `feat(runtime): add portable blocking and tool contracts`

## Milestone 2 — Codex App Server production transport

1. Add a process/connection boundary with deterministic fakes. Implement a
   newline-delimited JSON-RPC client with request correlation, initialization,
   bounded writes/reads, protocol error propagation, process-exit settlement,
   and idempotent cancellation.
2. Implement `CodexAppServerTransport` using official protocol primitives:
   `thread/start`, `turn/start`, `turn/completed`, `turn/interrupt`, item and
   delta notifications, server-initiated approvals/input/elicitation, dynamic
   tool calls, usage, and rate-limit notifications.
3. Implement the continuation state machine above. Only `CodexRuntime` decides
   whether another turn is needed; the Scheduler and Engine see one portable
   session/result. Validate thread, turn, and execution correlations separately.
4. Support request policies `block`, `reject`, and narrowly configured automatic
   decisions. Dynamic calls invoke only a matching captured portable capability;
   malformed names/arguments/results fail closed and bounded.
5. Add strict App Server runtime config parsing and host registration while
   retaining `codex-cli` as an optional compatibility runtime. No Codex types
   escape `src/runtimes/codex/`.
6. Test fragmented JSONL, out-of-order responses, malformed messages, early
   exit, initial/corrective/resume turns, valid result termination, max-turn
   exhaustion/classification, every blocking request, dynamic calls, usage/rate
   events, turn timeout, interrupt, cancellation, and fresh-thread restart.

Commit: `feat(codex): add app server transport`

## Milestone 3 — credential-safe Vikunja-native tools

1. Extend `ProviderAdapter` with task-scoped tool discovery returning portable
   host closures. Scheduler obtains them after claim with comments/artifacts and
   passes them in the captured execution request.
2. Implement tools for reading current task details, comments, and artifacts and
   adding a task comment. Mutations require a caller idempotency key and are
   restricted to the claimed task.
3. Validate JSON input before network calls, cap output, and return portable
   redacted failures. Never expose token, headers, client, or raw provider data.
4. Prove credentials cannot reach environment, prompt serialization, workspace,
   logs, snapshots, tool results, reviews, or package artifacts.

Commit: `feat(vikunja): add credential-safe agent tools`

## Milestone 4 — collision-safe workspace identity and containment

1. Add a workspace-manager namespace supplied by Host composition from provider
   name and repository registration ID. Name new workspaces with a readable
   prefix plus stable hash of namespace and opaque task ID.
2. Write an atomic, mode-restricted `.ensemble-runtime/workspace.json` manifest
   containing schema version, namespace, exact opaque task ID, and immutable
   repository identity. Validate size, ownership shape, exact keys, and content
   before restoration/enumeration; never put secrets or provider metadata in it.
3. Direct restoration never executes a legacy workspace. WorkspaceManager can
   enumerate contained non-symlink legacy entries as opaque ephemeral
   capabilities and can correlate those entries against a caller-supplied list
   of exact portable task identities. The historical naming function and all
   collision detection stay private to WorkspaceManager. Results expose only
   opaque `unique(taskId)`, `ambiguous`, or `unmatched` classifications, never a
   path or guessed provider task ID.
4. Add independently testable primitives that accept an opaque unique match and
   its exact caller-supplied Task, atomically rename it to the hashed path, write
   and re-read the manifest, and revalidate containment before making it
   restorable. Separate opaque quarantine/removal primitives never interpret
   provider state. No provider call, terminal decision, or Scheduler dependency
   is introduced in this milestone.
5. Centralize containment checks using absolute normalized paths, nearest
   existing ancestor realpaths, component `lstat`, and immediate revalidation
   before creation, restoration, runtime cwd exposure, and deletion. Reject root
   equality and symlink escapes; deletion never follows a malicious target.
6. Test normalized-ID collisions, manifest tampering/size/symlinks, opaque
   legacy enumeration and unique/ambiguous/unmatched matching, migration before
   use, namespace separation, and symlink/path replacement at every boundary.

Commit: `fix(workspace): harden identity and containment`

## Milestone 5 — repository refresh and bounded workspace hooks

1. Extend the repository driver to verify configured origin and branch and run a
   bounded argv-only fetch/update policy that preserves local commits and dirty
   work. Identity mismatch fails without replacing contents.
2. Execute `afterCreate`, `beforeRun`, `afterRun`, and `beforeRemove` with exact
   primary-error semantics, minimal environment, repository cwd, configured
   timeout, and bounded/redacted output.
3. ExecutionEngine invokes restore verification before `beforeRun`, runs
   `afterRun` once for all terminal attempt paths, and keeps hook failure
   secondary where the SPEC requires it.
4. Test wrong origin/branch, dirty/local-commit preservation, argv/cwd/env,
   output bounds/redaction, hook order, each failure semantic, timeout,
   cancellation, and cleanup races.

Commit: `feat(workspace): add refresh and lifecycle hooks`

## Milestone 6 — Scheduler-owned terminal and startup cleanup

1. Add a bounded complete-or-partial provider task inventory contract including
   terminal and archived tasks. Provider-specific pagination, routing, and
   completeness stay inside ProviderAdapter.
2. Expose the milestone-4 opaque inventory/match/migrate/quarantine/remove
   primitives through `TaskExecutionService`. Scheduler supplies the portable
   provider inventory tasks to the execution service; ExecutionEngine/
   WorkspaceManager privately calculate historical names and return opaque match
   classifications. Scheduler never sees a legacy path or naming function.
3. Before dispatch, Scheduler requests migration for every unique current-task
   match, cleanup for matched terminal/archived tasks, and cleanup for unmatched
   entries only when provider inventory is complete (authoritative missing).
   Partial/unreadable inventory and ambiguous matches are quarantined and
   retained. It then inventories manifested workspaces, refreshes their exact
   opaque IDs, and applies the same authoritative cleanup rules.
4. Scheduler triggers terminal removal after terminal completion and terminal
   reconciliation. Attempt cleanup/preservation remains separate from terminal
   removal; cleanup failure never makes work runnable.
5. Test startup-before-dispatch ordering, unique Vikunja numeric migration,
   terminal/missing deletion under complete inventory, partial/unreadable and
   ambiguous retention, invalid-manifest quarantine, beforeRemove failure,
   reconciliation cleanup, boundary ownership, and restart idempotency.

Commit: `feat(orchestration): clean terminal workspaces`

## Milestone 7 — immutable snapshots and read-only endpoints

1. Add deeply immutable bounded diagnostic contracts matching SPEC section 18.
   Scheduler publishes live execution state plus provider-derived diagnostic
   state using `workflow_diagnostics`; usage/rate events update bounded
   ephemeral aggregates while retry/block records reconstruct durably.
2. Orchestrator composes repository snapshots after startup and every tick with
   lifecycle, readiness, last tick, revision, and degradation. Partial provider
   diagnostics retain the last known snapshot and never become workflow truth.
3. Add optional loopback-by-default HTTP configuration and a Node HTTP server
   exposing only `GET /health`, `GET /ready`, and `GET /snapshot`. Reject other
   methods, bound responses/shutdown, and keep it observational.
4. Test restart reconstruction for blocked/retrying data, resolution removal,
   lifecycle transitions, mutation resistance, bounds, redaction, degraded
   repositories, listener failures, and graceful close.

Commit: `feat(observability): add snapshots and health endpoints`

## Milestone 8 — workflow, documentation, conformance, and release acceptance

1. Fix planner/implementation role transitions and document App Server,
   operator resolution, provider tools, workspace behavior, snapshots/endpoints,
   upgrade compatibility, and runtime requirements in generic and specific
   guides.
2. Add a named v0.3 conformance entry composing deterministic provider,
   Scheduler, Engine, Runtime, workspace, restart, blocking, snapshot, and
   shutdown scenarios without credentials or network.
3. Add argv-safe release verification: build, pack dry run, tarball manifest,
   configured sentinel scan, supervisor snapshots, and Node metadata. Never scan
   or print the real env file.
4. Produce `compliance-report.md` mapping MUSTs to evidence and list only
   external acceptance steps: real Linux/macOS service installs, registry/release
   publication, and a real provider/Codex run.
5. Reconcile stale Vikunja backlog tasks only after evidence; never copy a token
   into task comments.

Commit: `test: add v0.3 production conformance suite`

## Final gate

- Run all checks plus `npm pack --dry-run` and credential scans.
- Inspect the complete commit range for drift and accidental secret inclusion.
- Require an independent `pass` with no blocking issues.
- Stop if the same blocker survives two revisions or an external side effect
  lacks authorization.
