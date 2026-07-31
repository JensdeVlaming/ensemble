# Ensemble Specification

Version: 0.2
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

---

# 3. High-Level Architecture

```text
Task Provider
      │
      ▼
Provider Adapter
      │
      ▼
Scheduler
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

---

# 4. Components

## Scheduler

The Scheduler determines **what** should run.

Responsibilities:

* poll providers
* discover runnable tasks
* determine next agent role
* allocate execution
* retry failed work
* recover after restart

The Scheduler MUST be deterministic.

For a given provider snapshot and repository configuration, it MUST make the
same eligibility and role-selection decisions. Tasks returned by a poll MUST be
processed in ascending task-ID order.

The Scheduler owns all durable execution transitions. Neither the Execution
Engine nor a Runtime may directly change provider workflow state.

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
* cleanup

The Execution Engine MUST NOT contain runtime-specific logic.

An execution environment MUST be scoped to a single callback and MUST permit at
most one runtime invocation. The Execution Engine MUST attempt workspace cleanup
after success or failure. Cleanup, cancellation, or secondary event-stream
errors MUST NOT replace the primary runtime or scheduling failure.

---

## Runtime

A Runtime determines **how** an AI agent executes work.

Examples:

* Codex Runtime
* Claude Runtime
* OpenHands Runtime

Every runtime MUST expose the same interface.

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
}

interface ProviderExecutionState {
    active?: ActiveExecution;
    history: readonly ExecutionRecord[];
    nextRole?: string;
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
* Repeating completion or failure for an already-recorded execution ID MUST be
  safe and MUST NOT duplicate side effects.

Adapters MAY represent this state using native provider fields, comments,
labels, or another provider-owned mechanism. Ensemble MUST NOT require a local
durable database.

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

}
```

Notice that no prompt is provided.

The Runtime is responsible for converting this context into the appropriate execution format.

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
```

These events are consumed by the Execution Engine and Scheduler.

No runtime-specific parsing should exist outside the Runtime implementation.

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
Codex CLI
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

Codex CLI

* execute Codex

Event Parser

* parse structured runtime events

Result Builder

* generate a runtime-independent result

Nothing outside the runtime should understand how Codex works.

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

1. Polling the task provider.
2. Discovering workflow candidates, including tasks with active executions.
3. Reading the task's durable provider execution state.
4. Reading repository configuration.
5. Restoring or creating a workspace.
6. Launching a new runtime session.

When an active execution exists, the Scheduler MUST reuse its provider-stored
execution ID and role. Active recovery takes precedence over current task
status, configured runnable statuses, next-role state, and retry exhaustion.
The runtime session itself is new unless that runtime can safely resume from its
own provider-visible checkpoint.

Hidden runtime memory MUST NOT be required.

## 15.1 Role Selection and Eligibility

When there is no active execution, the Scheduler selects the role in this
order:

1. the provider-stored next role
2. the role of the most recent failed execution
3. the repository-configured initial role

A task with no most-recent failure is eligible only when its status is listed
in `statuses.runnable`. A task whose most recent execution failed is eligible
while the number of failed executions for the selected role is less than
`retry.maxFailedAttemptsPerRole`.

Failures are counted separately per role. A value of `0` permits the initial
execution but disables retries. An active execution is always recoverable and
does not consume another retry attempt merely because Ensemble restarted.

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
  config: {}
initialRole: planner
terminalOutcomes: [approved, completed]
statuses:
  runnable: [todo, in_progress]
  running: in_progress
  completed: done
  failed: failed
retry:
  maxFailedAttemptsPerRole: 3
```

`runtime.name` selects a registered Runtime. `runtime.config` is opaque to the
Scheduler and Execution Engine and is interpreted only by that Runtime.

`initialRole` MUST name a role present in `.ensemble/roles`. Every non-terminal
structured result MUST provide a `nextRole`, and that role MUST also exist.

`retry.maxFailedAttemptsPerRole` MUST be a non-negative integer and defaults to
`3`. Status and outcome strings are repository-defined rather than hard-coded
by the Scheduler.

Example:

```env
GITHUB_TOKEN=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
VIKUNJA_TOKEN=...
CLICKUP_TOKEN=...
```

---

# 18. Extensibility

Adding a new Task Provider requires only a new Provider Adapter.

Adding a new AI system requires only a new Runtime implementation.

Repositories should remain unchanged.

---

# 19. Design Philosophy

Ensemble coordinates autonomous software engineering.

It does not own project management.

It does not own source control.

It does not own CI.

Its responsibility is to continuously transform external tasks into completed software changes by orchestrating specialized AI agents through well-defined runtimes, repository-defined workflows, and provider-visible state.

Every provider should be replaceable.

Every runtime should be replaceable.

Every agent should be replaceable.

The orchestration model should remain stable.
