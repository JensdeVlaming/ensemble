# Ensemble Specification

Version: 0.3
Status: Draft

---

# 1. Overview

Ensemble is an orchestration platform for autonomous software engineering agents.

Ensemble does **not** implement software itself. Instead, it continuously discovers work, coordinates AI agents, manages execution environments, and synchronizes progress with external task providers.

Ensemble is designed around replaceable components:

* Task Providers
* Agent Runtimes
* Repositories
* Execution Environments

The goal is that any of these can be replaced without affecting the others.

Ensemble is a long-running service, not only an orchestration library. A
conforming deployment validates its configuration, continuously discovers and
reconciles work, dispatches bounded concurrent executions, recovers after
restart, and shuts down within configured bounds. Library entry points MAY
expose individual ticks for embedding and tests, but manual invocation MUST NOT
be the only supported operating mode.

## 1.1 Normative Language

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, and OPTIONAL are to be
interpreted as described by RFC 2119 and RFC 8174 when they appear in uppercase.

---

# 2. Design Principles

## 2.1 Task Provider is the Source of Truth

The task provider owns all workflow state.

This includes:

* task description
* acceptance criteria
* status
* comments
* labels
* assignments
* execution history
* the active execution marker
* the next requested role
* agent feedback

Ensemble MUST NOT duplicate this state.

After a restart, Ensemble MUST reconstruct execution solely from:

* the task provider
* the repository
* the workspace

---

## 2.2 Repository Defines Execution

Each repository contains a dedicated `.ensemble` directory.

Example:

```text
.ensemble/
├── config.yaml
├── WORKFLOW.md
└── roles/
    ├── planner.md
    ├── implementation.md
    ├── reviewer.md
    └── documentation.md
```

This directory completely describes how Ensemble should execute work for this repository.

---

## 2.3 Runtime Independence

Ensemble MUST NOT depend on a specific AI system.

Supported runtimes may include:

* Codex
* Claude Code
* OpenHands
* future runtimes

The scheduler should never know which runtime is executing work.

---

## 2.4 Provider Independence

Ensemble MUST NOT depend on:

* Vikunja
* ClickUp
* GitHub Issues
* Linear

Provider-specific behavior belongs exclusively inside Provider Adapters.

---

## 2.5 Runtime State is Ephemeral

Ensemble stores only temporary execution state.

Examples:

* active processes
* heartbeats
* workspace paths

Everything required to continue work MUST be recoverable.

Ephemeral registries and timers MAY optimize a live process, but MUST NOT be the
only source of claims, retry eligibility, execution history, or workflow
progress. Provider execution state and repository configuration remain the
durable reconstruction inputs.

---

## 2.6 Operational Safety

Ensemble MUST bound concurrency, waits, retries, hooks, startup, and shutdown.
It MUST NOT silently convert provider, configuration, runtime, or synchronization
errors into success. Secrets belong to the service host and MUST NOT be written
to a repository, workspace metadata, prompt, log, snapshot, or runtime child
environment unless that runtime explicitly requires the secret.

---

# 3. High-Level Architecture

```text
Orchestrator Service
      │
      ▼
Scheduler ◀──── Provider Adapter ◀──── Task Provider
      │
      ▼
Execution Engine
      │
      ▼
Runtime
      │
      ▼
AI Agent
      │
      ▼
Repository
```

Structured logs and read-only runtime snapshots observe every layer without
owning scheduling decisions. The dependency direction is:

```text
Orchestrator Service -> Scheduler -> Execution Engine -> Runtime
                              |
                              v
                       Provider Adapter
```

The Service owns process lifecycle and tick timing. The Scheduler owns all
decisions about what runs, stops, retries, or recovers. The Execution Engine
owns cancellable worker handles and execution environments. A Runtime owns its
protocol and agent session.

---

# 4. Components

## Orchestrator Service

The Orchestrator Service turns Ensemble into an always-on process.

Responsibilities:

* validate host and repository configuration before dispatch
* schedule recurring ticks without overlapping the same tick
* ask the Scheduler to reconcile, recover, retry, and dispatch work
* expose structured logs and immutable runtime snapshots
* accept shutdown and reload signals
* stop intake and drain or cancel workers during bounded graceful shutdown

The Service MUST NOT select roles, interpret provider metadata, calculate retry
eligibility, or invoke a Runtime directly. Those decisions remain behind the
Scheduler and Execution Engine boundaries.

At startup the Service MUST validate host configuration, load an initial valid
repository configuration for every configured repository it can resolve,
reconcile provider-owned active executions, and clean terminal workspaces before
normal dispatch. A configuration failure MUST prevent affected repositories
from dispatching but MUST NOT crash unrelated configured repositories.

`start()` MUST run until cancellation, fatal host failure, or shutdown. `tick()`
MAY remain public as a deterministic embedding and testing primitive.

## Scheduler

The Scheduler determines **what** should run.

Responsibilities:

* poll providers
* discover runnable tasks
* determine next agent role
* deterministically order candidates
* enforce global and per-state capacity
* dispatch non-blocking executions
* reconcile active executions
* classify failures and schedule timed retries
* recover after restart

The Scheduler MUST be deterministic.

For a given provider snapshot, clock instant, and repository configuration, it
MUST make the same eligibility, role-selection, reconciliation, retry, and
dispatch decisions. Candidates MUST be ordered by ascending provider-normalized
priority, with missing priority last, then ascending task ID. An adapter that
cannot supply priority leaves it absent.

The Scheduler owns all durable execution transitions. Neither the Execution
Engine nor a Runtime may directly change provider workflow state.

The Scheduler MAY maintain an in-process registry of running worker handles and
retry wakeups. This registry is ephemeral and MUST be reconstructable. Atomic
provider claims, not the registry, prevent duplicate durable executions.

---

## Execution Engine

The Execution Engine determines **where** work runs.

Responsibilities:

* create workspaces
* clone repositories
* checkout branches
* invoke runtimes
* monitor execution
* stream runtime events
* expose a cancellable live execution handle
* cleanup

The Execution Engine MUST NOT contain runtime-specific logic.

An execution environment MUST be scoped to a single worker and MUST permit at
most one active runtime invocation. Starting a run MUST return control to the
Scheduler with a handle that exposes its result, cancellation, activity, and
diagnostic snapshot. Awaiting the result is the worker's responsibility and
MUST NOT block the service tick or other dispatches.

The Execution Engine MUST attempt run-attempt cleanup after success, failure,
timeout, or cancellation. Cleanup, cancellation, hook, or secondary event-stream
errors MUST NOT replace the primary runtime or scheduling failure.

---

## Runtime

A Runtime determines **how** an AI agent executes work.

Examples:

* Codex Runtime
* Claude Runtime
* OpenHands Runtime

Every runtime MUST expose the same interface.

A Runtime MUST surface activity and blocking requests through portable events.
Runtime-specific approvals, user input, and tool elicitation MUST NOT be parsed
by the Scheduler or Execution Engine.

---

## Provider Adapter

Responsible for communication with task providers.

Responsibilities:

* discover workflow candidates
* read task details
* read comments
* read artifacts
* read durable execution state
* update status
* create comments
* upload artifacts
* atomically begin an execution
* atomically complete an execution
* atomically fail an execution
* atomically cancel or block an execution
* expose provider-native agent tools without exposing credentials

Provider Adapters MUST translate provider-specific assignment, archive, and
terminal-state concepts into the portable contracts defined below. No other
component may inspect provider-specific task metadata.

### Workflow Candidate Discovery

The Scheduler requests tasks using the semantic scope `workflow_candidates`.
A Provider Adapter MUST apply its provider-specific filters before returning
tasks. This prevents ineligible tasks from allocating workspaces or runtimes.

Candidate discovery MUST include every non-cancelled, non-archived task that has
a durable active Ensemble execution, even when its current workflow status would
not otherwise be runnable. This is required for restart recovery while still
respecting explicit provider-side cancellation.

Discovery is a coarse provider-side filter. Final eligibility, retry policy, and
role selection remain Scheduler responsibilities.

Every normalized task MUST include a stable opaque ID, provider status,
repository reference, and adapter-derived `dispatchable` flag. It MAY include a
provider-normalized integer priority and blocker summaries. Lower priority
numbers sort first. Assignment, archive, board membership, label, routing, and
blocker interpretation remain adapter-owned; the Scheduler only consumes the
portable `dispatchable` decision and configured portable statuses.

For reconciliation, an adapter MUST support refreshing a supplied set of active
task IDs in one bounded operation or bounded pages. Each requested ID MUST be
reported as a current task, missing, or temporarily unreadable. Missing and
temporarily unreadable are distinct: a transient provider error MUST NOT be
treated as authoritative deletion.

Adapters MUST handle provider pagination, rate limits, and transient failures.
They MUST NOT return partial discovery or reconciliation results as a complete
snapshot unless the result explicitly identifies itself as partial, in which
case the Scheduler MUST NOT make destructive reconciliation decisions from the
missing portion.

### Durable Execution State

Provider Adapters expose execution state through portable, provider-independent
records equivalent to:

```typescript
interface ActiveExecution {
    id: string;
    role: string;
    startedAt: string;
}

interface ExecutionRecord {
    id: string;
    role: string;
    outcome: string;
    summary: string;
    nextRole?: string;
    finishedAt: string;
    blockingRequest?: BlockingRequest;
    failure?: {
        kind: FailureKind;
        retryable: boolean;
        nextAttemptAt?: string;
    };
}

interface ProviderExecutionState {
    active?: ActiveExecution;
    history: readonly ExecutionRecord[];
    nextRole?: string;
}

type FailureKind =
    | "startup"
    | "provider"
    | "configuration"
    | "runtime"
    | "timeout"
    | "stalled"
    | "reconciliation"
    | "shutdown";

interface BlockingRequest {
    readonly kind: "approval" | "user_input" | "tool_elicitation";
    readonly summary: string;
    readonly requestId?: string;
    readonly createdAt: string;
}
```

Returned state MUST be validated, immutable to consumers, and ordered by
`finishedAt`, using execution ID as the deterministic tie-breaker.

The execution ID is the idempotency key for provider mutations:

* `beginExecution` MUST atomically create an active marker and running status,
  or return the already-active execution.
* `completeExecution` MUST atomically persist the history record, comments,
  artifacts, next role, and resulting status, then clear the active marker.
* `failExecution` MUST atomically persist the failed record and diagnostic
  comment, apply the failed status, and clear the active marker.
* `cancelExecution` MUST atomically persist the cancellation classification and
  clear the active marker. It MUST NOT schedule a retry for terminal, missing,
  or newly ineligible work.
* `blockExecution` MUST atomically persist an operator-action request, apply the
  configured blocked status, and clear the active marker. Resumption requires a
  later provider state that is eligible under current configuration.
* Repeating completion, failure, cancellation, or blocking for an
  already-recorded execution ID MUST be safe and MUST NOT duplicate side
  effects.

Every failed record MUST contain a failure classification. A retryable failure
MUST contain an absolute `nextAttemptAt` computed by the Scheduler. This keeps
retry due time reconstructable after restart; an in-memory timer is only a
wakeup optimization. Cancellation caused by reconciliation or shutdown is not
retryable unless current provider state and explicit policy later make it so.

Adapters MAY represent this state using native provider fields, comments,
labels, or another provider-owned mechanism. Ensemble MUST NOT require a local
durable database.

### Production Adapter Profile

The runnable Ensemble distribution MUST include at least one end-to-end
production Provider Adapter. A production adapter MUST demonstrate:

* paginated discovery and targeted active-task refresh
* rate-limit observation and bounded retry of provider reads
* assignment, label, archive, terminal, routing, and blocker filtering
* atomic execution claims under competing service processes
* idempotent completion, failure, cancellation, and blocking synchronization
* startup reconstruction from provider-owned execution state
* provider-native tools whose host-managed credentials are not placed in agent
  prompts, workspaces, or child-process environments

Additional adapters MAY live in separate packages, but at least one supported
profile MUST be runnable without downstream adapter implementation work.

---

# 5. Repository Layout

```text
repository/
├── README.md
├── AGENTS.md
├── src/
├── tests/
└── .ensemble/
    ├── config.yaml
    ├── WORKFLOW.md
    └── roles/
```

---

# 6. AGENTS.md

`AGENTS.md` contains repository instructions intended for every AI tool.

Examples:

* architecture
* coding conventions
* testing strategy
* documentation standards

Every runtime MUST load this file.

---

# 7. WORKFLOW.md

`WORKFLOW.md` defines how Ensemble executes work inside this repository.

Typical contents include:

* execution strategy
* completion requirements
* reporting requirements
* validation requirements
* workflow expectations

Unlike `AGENTS.md`, this document is intended specifically for Ensemble orchestrated execution.

`WORKFLOW.md`, `AGENTS.md`, role files, and `.ensemble/config.yaml` form one
versioned repository configuration revision. Validation and hot reload MUST load
them atomically. A changed file MUST NOT be observed with stale siblings, and an
invalid revision MUST leave the complete last-known-good revision active.

---

# 8. Roles

Roles define responsibilities.

Examples:

* Planner
* Implementation
* Reviewer
* Documentation
* Security
* Performance

Roles are stored inside:

```text
.ensemble/roles/
```

Each role contains additional instructions layered on top of `WORKFLOW.md`.

---

# 9. Runtime

The Runtime is the most important abstraction inside Ensemble.

The Scheduler decides **what** to execute.

The Execution Engine decides **where** to execute.

The Runtime decides **how** to execute.

The Runtime owns:

* context construction
* prompt construction
* agent invocation
* event streaming
* structured result generation
* runtime-specific configuration
* checkpointing (when supported)
* resume (when supported)

---

# 10. Runtime Interface

Every runtime MUST implement the same interface.

```typescript
interface Runtime {

    readonly name: string;

    prepare(
        context: RuntimeContext,
    ): Promise<PreparedRun>;

    start(
        prepared: PreparedRun,
    ): Promise<RuntimeSession>;

    resume(
        session: RuntimeSession,
        context: ResumeContext,
    ): Promise<RuntimeSession>;

    cancel(
        session: RuntimeSession,
    ): Promise<void>;

}
```

`RuntimeSession` MUST expose an asynchronous event stream, a structured result
promise, a stable runtime-session identifier when the backend provides one, and
an idempotent cancellation path. It MAY span multiple agent turns. Session and
turn IDs are diagnostic values only and MUST NOT replace the provider execution
ID as the durable idempotency key.

The Execution Engine wraps a `RuntimeSession` in a portable live handle
equivalent to:

```typescript
interface RunningExecution {
    readonly executionId: string;
    readonly result: Promise<ExecutionReport>;
    readonly startedAt: string;
    snapshot(): RunningExecutionSnapshot;
    cancel(reason: CancellationReason): Promise<void>;
}
```

`cancel` MUST be idempotent and bounded by the configured cancellation timeout.
Cancellation first requests cooperative runtime shutdown and then MAY terminate
runtime-owned processes according to runtime policy. The Scheduler records the
durable provider transition after the handle settles or the cancellation bound
expires.

---

# 11. Runtime Context

A Runtime receives everything required to execute work.

```typescript
interface RuntimeContext {

    repository;

    workspace;

    task;

    comments;

    artifacts;

    workflow;

    agents;

    role;

    runtimeConfig;

    tools;

}
```

Notice that no prompt is provided.

The Runtime is responsible for converting this context into the appropriate execution format.

`tools` contains portable, host-executed tool definitions made available by the
Provider Adapter or deployment. A definition includes a name, description,
validated input schema, and invocation capability. Credentials remain captured
by the host capability and MUST NOT appear in the definition, runtime process
environment, or tool result. The Runtime owns protocol-specific tool
registration and translates each invocation to the portable host capability.

---

# 12. Runtime Events

A Runtime continuously emits structured events.

Examples:

```text
RunStarted

ProgressUpdated

ToolStarted

ToolFinished

ValidationStarted

ValidationFinished

ArtifactCreated

CommentRequested

NextAgentRequested

RunCompleted

RunFailed

ApprovalRequested

UserInputRequested

ToolElicitationRequested

UsageUpdated

RateLimitUpdated

Heartbeat
```

These events are consumed by the Execution Engine and Scheduler.

No runtime-specific parsing should exist outside the Runtime implementation.

Every event MUST carry the provider execution ID, event type, timestamp, and a
redacted portable payload. Activity-bearing events refresh stall detection.
Runtime implementations MUST document which events count as activity; protocol
noise alone SHOULD NOT keep a stalled execution alive.

Approval, user-input, and tool-elicitation requests MUST become a portable
`BlockingRequest`. Policy MAY resolve a request automatically. Otherwise the
Scheduler MUST cancel or suspend the live session within configured bounds,
persist a blocked execution transition through the Provider Adapter, and expose
the request in diagnostics. A run MUST NOT wait indefinitely for an operator.

---

# 13. Codex Runtime

The reference runtime is Codex.

Internally it consists of:

```text
Context Builder
        │
        ▼
Prompt Builder
        │
        ▼
Codex App Server Transport
        │
        ▼
Event Parser
        │
        ▼
Result Builder
```

Responsibilities:

Context Builder

* load WORKFLOW.md
* load AGENTS.md
* load role instructions
* load task
* load comments

Prompt Builder

* construct runtime-specific prompt

Codex App Server Transport

* start and supervise the App Server protocol
* keep a thread alive for bounded continuation turns
* translate approvals, input requests, tool calls, usage, and rate limits
* execute provider-native tools on the host without revealing credentials
* enforce read, turn, stall, and cancellation timeouts

Event Parser

* parse structured runtime events

Result Builder

* generate a runtime-independent result

Nothing outside the runtime should understand how Codex works.

The App Server transport is the production Codex transport. A one-shot
`codex exec --json` transport MAY remain as a development or compatibility
fallback, but it is not sufficient for production-runtime conformance.

Continuation turns MUST reuse the live App Server thread and MUST be bounded by
`runtime.maxTurns`. A process restart MAY create a fresh thread while reusing
the provider execution ID; hidden App Server state is never required for
orchestration recovery.

---

# 14. Structured Result

Every Runtime MUST return a structured result.

Example:

```json
{
  "outcome": "approved",
  "summary": "Implementation completed successfully.",
  "nextRole": "documentation",
  "comments": [],
  "artifacts": [
    {
      "type": "pull_request",
      "url": "https://github.com/example/repo/pull/42"
    }
  ]
}
```

Workflow transitions MUST be based on structured results, never on free-form text.

---

# 15. State Reconstruction

After a restart Ensemble reconstructs execution by:

1. Validating host configuration and loading repository configuration.
2. Polling the task provider.
3. Discovering workflow candidates, including tasks with active executions.
4. Reading each task's durable provider execution state.
5. Recomputing retry eligibility and due times from durable history.
6. Cleaning terminal workspaces and reconciling stale active executions.
7. Restoring or creating an eligible workspace.
8. Launching a fresh runtime session within current capacity.

When an active execution exists, the Scheduler MUST reuse its provider-stored
execution ID and role. Active recovery takes precedence over ordinary runnable
status, next-role state, and retry exhaustion, but not over authoritative
terminal, archived, missing, blocked, or unroutable provider state. The runtime
session itself is new unless that runtime can safely resume from its own
provider-visible checkpoint.

Hidden runtime memory MUST NOT be required.

## 15.1 Role Selection and Eligibility

When there is no active execution, the Scheduler selects the role in this
order:

1. the provider-stored next role
2. the role of the most recent failed execution
3. the repository-configured initial role

A task with no most-recent failure is eligible only when its status is listed
in `statuses.runnable`, the adapter marks it dispatchable, and no unresolved
portable blocker prevents dispatch. A task whose most recent execution failed
is eligible only when that failure is retryable, its `nextAttemptAt` is due, it
is still dispatchable under current provider state and configuration, and the
number of failed executions for the selected role is less than
`retry.maxFailedAttemptsPerRole`.

Failures are counted separately per role. A value of `0` permits the initial
execution but disables retries. An active execution is always recoverable and
does not consume another retry attempt merely because Ensemble restarted.

## 15.2 Service Tick

A service tick MUST execute these phases in order:

1. reload and validate changed configuration
2. refresh and reconcile every live task
3. enforce stall and turn deadlines
4. discover workflow candidates
5. read durable execution state and compute due retries
6. deterministically sort eligible candidates
7. atomically claim and dispatch candidates until capacity is exhausted
8. publish a new immutable runtime snapshot

Ticks MUST NOT overlap. Slow provider calls MAY delay a later tick, but the
service MUST NOT accumulate an unbounded timer backlog. Worker completion is
handled asynchronously and MUST trigger durable synchronization independently
of the next discovery tick.

Global capacity counts every starting, running, cancelling, and blocked-draining
worker. Per-state capacity uses the latest normalized provider status. A task
MUST hold capacity before the Scheduler attempts its atomic provider claim. If
the claim loses a race, the reservation MUST be released without launching a
Runtime.

## 15.3 Active Reconciliation

Before dispatch on every tick, the Scheduler MUST refresh all live task IDs. It
MUST cancel a worker when authoritative provider state shows that the task:

* is terminal or archived
* is no longer dispatchable or has become blocked
* no longer satisfies configured runnable status policy
* has moved to a repository or route this service does not own
* is authoritatively missing

A partial refresh, rate limit, timeout, or transient provider failure MUST NOT
be interpreted as task removal. The worker MAY continue until the next refresh,
subject to its normal timeouts. Reconciliation cancellation MUST record its
reason durably when the provider still accepts mutations and MUST always release
local capacity and run terminal workspace cleanup as applicable.

## 15.4 Retry Policy

Failures are classified as `startup`, `provider`, `configuration`, `runtime`,
`timeout`, `stalled`, `reconciliation`, or `shutdown`. Configuration defines
which classes are retryable. Provider synchronization failures MUST be retried
idempotently before starting another execution with the same task.

For retry number `n`, starting at `1`, the Scheduler computes:

```text
delay = min(maxDelay, initialDelay * multiplier^(n - 1))
nextAttemptAt = finishedAt + deterministicJitter(delay, executionId)
```

`multiplier` MUST be at least `1`. Jitter MUST be deterministic from durable
inputs, bounded by configuration, and MUST NOT produce a negative delay. The
computed absolute `nextAttemptAt`, failure class, and retryability MUST be stored
in provider execution history. Changing configuration affects future failure
decisions; it MUST NOT silently rewrite already-persisted retry due times.

Retry wakeup timers MAY cause an early tick, but a timer firing does not grant
eligibility. The Scheduler MUST refresh the task, reread durable state, validate
current configuration, and acquire capacity and an atomic claim again.

## 15.5 Timeouts and Stall Detection

The following independent bounds MUST be configurable:

* service startup
* provider read and mutation operations
* runtime start
* runtime turn
* runtime inactivity or stall
* cooperative cancellation
* workspace hooks
* graceful shutdown drain

Stall detection uses the last activity-bearing runtime event. When a stall or
turn deadline expires, the Scheduler cancels the worker, records the appropriate
failure class, and applies retry policy. A timeout MUST settle local worker
ownership even when a Runtime does not cooperate; detached result and event
channels MUST be drained or safely ignored without unhandled rejection.

## 15.6 Graceful Shutdown

On shutdown the Service MUST stop scheduling new ticks and dispatches, then
allow live workers to drain for `shutdown.drainTimeoutMs`. At the deadline it
MUST request cancellation of remaining workers and wait no longer than
`timeouts.cancellationMs`. It MUST flush durable transitions and structured logs
within the remaining shutdown bound.

A process-forced exit MAY leave provider active markers. Startup recovery MUST
therefore treat them as expected reconstruction input, not corruption. Shutdown
cancellation is non-retryable by default; an unchanged eligible provider task
may be recovered on the next startup according to explicit recovery policy.

---

# 16. Workspace

Each task receives an isolated workspace.

```text
/workspaces/
└── vikunja-1842/
    ├── repository/
    └── .ensemble-runtime/
```

Workspaces are disposable.

The repository and task provider remain the persistent sources of truth.

New workspace directory names MUST combine a readable task prefix with a stable
hash of the provider/repository namespace and the exact opaque task ID. Each
workspace MUST contain a mode-restricted `.ensemble-runtime/workspace.json`
manifest recording the schema version, namespace, exact task ID, and immutable
repository identity. Restoration MUST validate that manifest before exposing a
runtime working directory. Legacy directories without a manifest MUST never be
restored directly; migration classifies them through opaque handles and requires
an exact, unambiguous caller-supplied task identity before use.

The configured workspace root MUST resolve to an absolute path before service
startup. Every derived workspace path MUST be collision-resistant, MUST remain
strictly contained by that root after normalization and symbolic-link checks,
and MUST NOT equal the root itself. Creation, restoration, hooks, runtime
working directories, and deletion MUST reject a path that violates containment.

Workspace lifecycle hooks are:

* `afterCreate`: once, after a new workspace and repository are materialized;
  failure aborts creation
* `beforeRun`: before every runtime attempt; failure aborts that attempt
* `afterRun`: after every attempt outcome; failure is logged and does not replace
  the attempt outcome
* `beforeRemove`: before deletion; failure is logged and deletion continues

Hooks MUST be expressed as executable plus argv, never an interpolated shell
command string. They execute with the workspace repository as their working
directory, a minimal documented environment, and a configured timeout. Hook
output is bounded and redacted before logging.

Restored workspaces MUST verify repository identity and synchronize from the
configured upstream using repository-owned argv operations before `beforeRun`.
The exact update policy is repository configuration and MUST preserve local work
needed for restart recovery. A mismatch MUST fail safely rather than replacing
the workspace contents.

Terminal provider state triggers workspace cleanup. Startup MUST discover and
clean stale workspaces whose authoritative provider tasks are terminal, archived,
or authoritatively missing. Deletion is best-effort and observable; failure does
not make a terminal task runnable again.

---

# 17. Configuration

Repository configuration lives inside:

```text
.ensemble/
```

Secrets NEVER live inside repositories.

Secrets are supplied by the Ensemble deployment.

Repository execution policy is defined by `.ensemble/config.yaml`. The portable
configuration keys are:

```yaml
runtime:
  name: codex
  config:
    transport: app-server
    maxTurns: 20
    operatorRequests: block
initialRole: planner
terminalOutcomes: [approved, completed]
statuses:
  runnable: [todo, in_progress]
  running: in_progress
  completed: done
  failed: failed
  blocked: blocked
service:
  pollIntervalMs: 30000
concurrency:
  global: 10
  byStatus:
    in_progress: 5
retry:
  maxFailedAttemptsPerRole: 3
  initialDelayMs: 1000
  maxDelayMs: 300000
  multiplier: 2
  jitterRatio: 0.2
  retryableFailureKinds: [startup, provider, runtime, timeout, stalled]
timeouts:
  startupMs: 30000
  providerMs: 30000
  runtimeStartMs: 30000
  turnMs: 3600000
  stallMs: 300000
  cancellationMs: 10000
shutdown:
  drainTimeoutMs: 30000
workspace:
  hooks:
    beforeRun:
      executable: npm
      args: [install]
  hookTimeoutMs: 60000
```

`runtime.name` selects a registered Runtime. `runtime.config` is opaque to the
Scheduler and Execution Engine and is interpreted only by that Runtime.

When a Runtime can request approval, user input, or tool elicitation, its
configuration MUST select a documented policy: automatically resolve allowed
requests, reject them, or persist blocked work. Persisting blocked work requires
`statuses.blocked`.

`initialRole` MUST name a role present in `.ensemble/roles`. Every non-terminal
structured result MUST provide a `nextRole`, and that role MUST also exist.

`retry.maxFailedAttemptsPerRole` MUST be a non-negative integer and defaults to
`3`. Retry delays and all timeout and concurrency values MUST be finite,
non-negative integers, except enabled capacities and `retry.multiplier`, which
MUST be positive. Status and outcome strings are repository-defined rather than
hard-coded by the Scheduler.

The service MUST use a complete YAML parser for repository configuration.
Unsupported tags, duplicate keys, non-object roots, and invalid typed values
MUST fail validation. A deliberately partial YAML subset is not conforming for
the runnable service.

Configuration is loaded before dispatch from a repository configuration source,
such as a validated checkout or repository mirror; allocating a task workspace
MUST NOT be required merely to decide whether that task can dispatch. The same
validated configuration object is passed into the worker, preventing a tick and
its execution from observing different revisions.

The Service MUST check for repository configuration changes before every tick.
Valid changes apply to future dispatches, retry decisions, hooks, and timeout
checks as documented by each key. Already-running workers retain their captured
configuration except that reduced concurrency stops new dispatch and explicitly
dynamic safety limits MAY become stricter. Invalid reloads MUST preserve the
last-known-good configuration, prevent first-time dispatch where no valid
configuration exists, and emit a diagnostic; they MUST NOT silently install
partial defaults.

String values explicitly documented as secret references MAY use `$NAME`
environment indirection. Resolution occurs on the host during validation. A
missing or empty referenced secret is a validation error. Arbitrary environment
substitution in workflow instructions is forbidden, and resolved secrets MUST
be redacted from errors, logs, snapshots, and runtime context.

Example:

```env
GITHUB_TOKEN=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
VIKUNJA_TOKEN=...
CLICKUP_TOKEN=...
```

---

# 18. Observability

Structured logs are required. Every log record MUST include a timestamp, level,
event name, service instance ID, and relevant provider, repository, task, role,
and execution IDs. Logs MUST cover startup validation, ticks, candidate
decisions, claims, dispatch, runtime lifecycle, reconciliation, retries,
blocking requests, timeouts, provider synchronization, cleanup, reload, and
shutdown. Payloads MUST be bounded and secret-redacted.

The Service MUST expose an immutable runtime snapshot equivalent to:

```typescript
interface ServiceSnapshot {
    readonly generatedAt: string;
    readonly service: "starting" | "running" | "draining" | "stopped";
    readonly configurationRevision?: string;
    readonly lastTick?: TickDiagnostic;
    readonly running: readonly RunningDiagnostic[];
    readonly retrying: readonly RetryDiagnostic[];
    readonly blocked: readonly BlockedDiagnostic[];
    readonly recentErrors: readonly ErrorDiagnostic[];
    readonly usage: Readonly<Record<string, UsageTotals>>;
    readonly rateLimits: Readonly<Record<string, RateLimitSnapshot>>;
}
```

Per-execution diagnostics MUST include task and execution IDs, role, provider
status, lifecycle state, start time, last activity time, current runtime session
and turn identifiers when available, turn count, workspace path, applicable
deadline, retry due time, blocking request, last event summary, token usage, and
last error. Snapshots MUST be defensively copied, bounded in history, and MUST
not expose provider credentials, prompts containing secrets, raw tool arguments,
or mutable internal handles.

A read-only JSON API and dashboard MAY present snapshots, health, and readiness.
If present, they MUST NOT become a second control plane or durable state store.
Readiness is false until initial validation and startup reconciliation complete.
Health is false only when the service cannot continue making bounded progress;
an individual task or repository failure is diagnostic degradation, not
necessarily process failure.

---

# 19. Executable and Deployment

Ensemble MUST provide an executable entry point that can:

* select host configuration and registered providers and runtimes
* validate configuration without dispatching work
* start the long-running service
* handle platform termination signals
* emit structured logs to standard output
* expose health, readiness, and snapshot endpoints when configured

The executable MUST return a non-zero exit code for invalid host configuration,
startup timeout, or fatal service failure. Repository-specific validation
failures after startup are surfaced per repository and do not require whole
process termination.

The project SHOULD publish self-contained macOS and Linux release artifacts.
Release artifacts MUST document supported Node.js or bundled-runtime versions,
configuration discovery, required external executables, workspace ownership,
signal behavior, and upgrade compatibility for provider execution records.

---

# 20. Extensibility

Adding a new Task Provider requires only a new Provider Adapter.

Adding a new AI system requires only a new Runtime implementation.

Repositories should remain unchanged.

---

# 21. Design Philosophy

Ensemble coordinates autonomous software engineering.

It does not own project management.

It does not own source control.

It does not own CI.

Its responsibility is to continuously transform external tasks into completed software changes by orchestrating specialized AI agents through well-defined runtimes, repository-defined workflows, and provider-visible state.

Every provider should be replaceable.

Every runtime should be replaceable.

Every agent should be replaceable.

The orchestration model should remain stable.
