# Ensemble Specification

Version: 0.1
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

* discover tasks
* read task details
* read comments
* update status
* create comments
* upload artifacts

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
2. Discovering active tasks.
3. Reading repository configuration.
4. Restoring workspaces.
5. Launching a new runtime session.

Hidden runtime memory MUST NOT be required.

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
