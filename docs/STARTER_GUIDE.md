# Ensemble Starter Guide

This guide takes Ensemble from installation to its first real task. It also
explains the two configuration layers, how repository roles become workflow
stages, how providers participate in eligibility, and how to operate Ensemble
in the foreground or as a service. Adapter-specific setup lives in the
[provider guides](providers/README.md).

## 1. Mental model

Ensemble connects four layers:

```text
Provider task
    ↓
Scheduler chooses an eligible task and role
    ↓
Execution Engine creates or restores a workspace
    ↓
Configured Runtime performs one role
```

The configured provider remains the durable source of truth for tasks, claims, retries, and
workflow status. Ensemble does not replace the task tracker. It continuously
polls the tracker, starts bounded workers, reconciles changed tasks, and writes
durable execution results back through the provider adapter.

Some providers can also send authenticated wake hints. A hint only asks the
service to poll that repository sooner; it never supplies trusted task state,
changes scheduling policy, or replaces periodic polling.

There are two distinct configuration layers:

| Layer | Purpose | Typical location |
|---|---|---|
| Host configuration | Providers, credentials references, local runtime executables, repository registrations, workspaces and service settings | macOS Application Support or `/etc/ensemble` |
| Repository configuration | Workflow instructions, roles, status mapping, concurrency, retries and execution deadlines | Versioned in the target repository |

The host configuration is operator-owned. The repository configuration is
project-owned and should normally be committed with the repository.

## 2. Requirements

- Node.js 22.6 or newer.
- Git.
- A supported task-provider adapter. Follow its dedicated guide under
  [`docs/providers`](providers/README.md).
- An executable or service endpoint required by each selected runtime adapter.
  Follow its dedicated guide under [`docs/runtimes`](runtimes/README.md).
- A local checkout containing the repository's Ensemble configuration.

Windows may run `ensemble run` where the Node.js dependencies work, but Windows
Service installation is not supported in this release.

## 3. Install the CLI

From the Ensemble source repository:

```sh
npm install
npm run build
npm pack
npm install --global ./ensemble-0.1.0.tgz
```

Confirm that the installed executable is active:

```sh
ensemble --help
```

The CLI provides:

```text
ensemble init
ensemble validate
ensemble doctor
ensemble status
ensemble inspect task <id>
ensemble run
ensemble service install|uninstall|start|stop|restart|status|logs
```

## 4. Initialize the host

Run:

```sh
ensemble init
```

This creates a configuration template, protected environment file, state
directory, and workspace directory. Existing files are not overwritten.

### macOS defaults

```text
~/Library/Application Support/Ensemble/config.yaml
~/Library/Application Support/Ensemble/ensemble.env
~/Library/Application Support/Ensemble/state
~/Library/Application Support/Ensemble/workspaces
~/Library/Logs/Ensemble
```

### Linux defaults

```text
/etc/ensemble/config.yaml
/etc/ensemble/ensemble.env
/var/lib/ensemble
/var/lib/ensemble/workspaces
```

Linux initialization and system-service installation require permission to
write these system paths. The installed systemd service runs under a dedicated
`ensemble` account.

Explicit host files can be selected for applicable commands:

```sh
ensemble validate \
  --config "/absolute/path/config.yaml" \
  --env-file "/absolute/path/ensemble.env"
```

Both paths must be absolute.

## 5. Configure protected environment values

The env file contains bounded `NAME=VALUE` records. It is deliberately not a
shell script: there is no `export`, quoting, interpolation, or command
evaluation.

Example for macOS:

```text
TASK_PROVIDER_TOKEN=replace-with-a-real-token
```

Example for Linux:

```text
TASK_PROVIDER_TOKEN=replace-with-a-real-token
```

On macOS, the file must be owned by the current user with mode `0600`:

```sh
chmod 600 "$HOME/Library/Application Support/Ensemble/ensemble.env"
```

On Linux, it must either be owned by the service user with mode `0600`, or be
root-owned and group-readable by the `ensemble` group with mode `0640`.

Do not put tokens in host YAML, `.ensemble`, `AGENTS.md`, runtime prompts, or
the Git repository. The host YAML refers to a secret by name:

```yaml
token: $TASK_PROVIDER_TOKEN
```

Runtime authentication and process requirements are adapter-specific. Follow
the selected [runtime guide](runtimes/README.md). Runtime child processes
receive only explicitly allowlisted variables. Provider credentials and
credential-shaped variables such as API keys and tokens are rejected from the
runtime environment.

## 6. Configure the host

A host configuration registers local runtimes and one or more repositories.
Provider and runtime blocks are adapter-specific, so the following shows the
shared host shape with explicit placeholders:

```yaml
version: 1

service:
  startupTimeoutMs: 30000
  stopTimeoutSeconds: 60

logging:
  level: info

workspace:
  root: /absolute/path/to/ensemble-workspaces
  preserve: true
  gitExecutable: /absolute/path/to/git

runtimes:
  - name: agent-runtime
    # Replace the remaining mapping with the exact configuration from the
    # selected guide under docs/runtimes/.
    type: runtime-specific

repositories:
  - id: my-project
    url: https://github.com/example/my-project.git
    branch: main
    configurationPath: /absolute/local/path/to/my-project
    provider:
      # Replace this mapping with the exact configuration from the selected
      # guide under docs/providers/.
      type: provider-specific
```

### `configurationPath` versus workspace path

`configurationPath` is a local checkout used to load the project's workflow
configuration. It points to a repository directory, not to a YAML file:

```yaml
configurationPath: /Users/example/src/my-project
```

That checkout must already exist and contain:

```text
my-project/
├── AGENTS.md
└── .ensemble/
    ├── config.yaml
    ├── WORKFLOW.md
    └── roles/
        └── one-or-more-role-files.md
```

Ensemble does not perform task work directly in `configurationPath`. It creates
or restores separate per-task working copies below `workspace.root`. Preserving
those workspaces is the default and helps diagnosis and traceability.

### Runtime registration is optional

Only configured runtimes are registered. A host can start without an optional
runtime installed when no repository selects it. If repository configuration
contains:

```yaml
runtime:
  name: agent-runtime
```

then the host must contain a runtime registration with the same logical name.
Executable paths, authentication, environment variables, arguments and
protocol settings depend on the adapter. Use
[`docs/runtimes/README.md`](runtimes/README.md) to select its guide. Runtime
credentials must stay outside repository configuration.

### Provider configuration

The `provider` mapping determines where tasks come from and how provider-native
assignment, routing, status, archive state, blockers, claims, leases and durable
execution records are represented. Code outside the adapter does not interpret
provider metadata.

Each adapter has different credentials, identifiers, filters and setup steps.
Do not copy fields from one provider to another. Select a guide from
[`docs/providers/README.md`](providers/README.md), place its provider block in
each repository registration, and store its secrets only in the protected env
file.

## 7. Configure the repository

Repository configuration consists of four required pieces:

```text
AGENTS.md
.ensemble/config.yaml
.ensemble/WORKFLOW.md
.ensemble/roles/*.md
```

The loader reads a stable snapshot of all these files before dispatch. Changes
are checked before every polling tick. A valid change applies to future work;
an invalid change retains the last-known-good revision and produces a
diagnostic.

### Root `AGENTS.md`

`AGENTS.md` contains repository-wide instructions given to every role. Good
subjects include architecture boundaries, coding conventions, verification
commands, source-control rules, and safety requirements.

It does not define which workflow stages exist.

### `.ensemble/WORKFLOW.md`

`WORKFLOW.md` contains instructions shared across the entire agent workflow.
For example:

```markdown
# Project workflow

Understand the task and acceptance criteria before editing code. Implement the
smallest complete change, run the relevant automated checks, and finish with an
independent review.

Every non-terminal result must select the next valid role. A run is complete
only when the reviewer returns `approved`.
```

### `.ensemble/roles/*.md`

Every Markdown filename in `.ensemble/roles` defines an available role. The
filename without `.md` is the role name:

```text
.ensemble/roles/planner.md         → planner
.ensemble/roles/implementation.md  → implementation
.ensemble/roles/reviewer.md        → reviewer
```

At least one role file is required. A role file contains the instructions that
the selected runtime receives for that stage.

Roles are instructions, not separate processes, permission profiles, models,
or services. Every role selected by one repository uses that repository's
configured runtime with a different role name and role instruction document.
Role text can ask the agent to limit its actions, but it is not an
operating-system security boundary.

### How a role is selected

The Scheduler selects the role in this order:

1. Durable `nextRole` stored by the provider from the previous successful turn.
2. The role of the most recent failed execution, so retries repeat that stage.
3. `initialRole` from `.ensemble/config.yaml` for new work.

The selected role, repository-wide `AGENTS.md`, shared `WORKFLOW.md`, task,
comments, artifacts, workspace information and runtime configuration form the
portable runtime context. The selected runtime decides how to translate that
context into its native prompt, request or protocol.

### How stages transition

The presence of role files determines which stage names exist, but it does not
define a fixed order. `initialRole` selects the first stage. After that, the
currently running agent returns a structured result containing `nextRole`.

For example:

```json
{
  "outcome": "planned",
  "summary": "The implementation and verification work is defined.",
  "nextRole": "implementation",
  "comments": [],
  "artifacts": []
}
```

For a non-terminal outcome, `nextRole` is required and must match an existing
role filename. An outcome listed in `terminalOutcomes` ends the workflow and
must not require another role.

Therefore, role transitions should be explicit in the instructions. A planner
role might be:

```markdown
# Planner

Inspect the task, acceptance criteria, repository instructions and relevant
code. Produce a concrete implementation and verification plan. Do not claim
completion.

When planning is complete, return a non-terminal structured result with
`nextRole: implementation`.
```

An implementation role might be:

```markdown
# Implementation

Implement the planned behavior, preserve repository architecture boundaries,
and run the relevant automated checks.

When implementation and tests are complete, return a non-terminal structured
result with `nextRole: reviewer`.
```

A reviewer role might be:

```markdown
# Reviewer

Review the complete change against the task, acceptance criteria, repository
instructions and test evidence. Fixes that remain necessary must not be
described as approval.

Return terminal outcome `approved` only when no required work remains. If more
implementation is required, return a non-terminal result with
`nextRole: implementation`.
```

This permits a review loop:

```text
planner → implementation → reviewer ──approved──▶ complete
                         ▲          │
                         └──────────┘ changes required
```

### `.ensemble/config.yaml`

A minimal provider-neutral repository configuration is:

```yaml
runtime:
  name: agent-runtime
  config: {}

initialRole: planner
terminalOutcomes: [approved, completed]

statuses:
  runnable: [ready, running]
  running: running
  completed: completed
  failed: failed
  blocked: blocked
```

The repository status names are portable orchestration states. Each provider
adapter maps those states to its own native representation.

An explicit operational configuration can add:

```yaml
service:
  pollIntervalMs: 30000

concurrency:
  global: 2
  byStatus:
    running: 2

retry:
  maxFailedAttemptsPerRole: 3
  initialDelayMs: 1000
  maxDelayMs: 300000
  multiplier: 2
  jitterRatio: 0.2
  retryableFailureKinds:
    - startup
    - provider
    - configuration
    - runtime
    - timeout
    - stalled
    - reconciliation
    - shutdown

timeouts:
  startupMs: 30000
  providerMs: 30000
  runtimeStartMs: 30000
  turnMs: 3600000
  stallMs: 300000
  cancellationMs: 10000

shutdown:
  drainTimeoutMs: 30000
```

`pollIntervalMs` is completion-relative: the next wait begins after the
previous tick finishes. A slow tick therefore does not accumulate overlapping
timer callbacks.

Concurrency is bounded by the global value and optional current-status values.
Retries are durable per role and use provider execution history, scheduled due
times, exponential delay and deterministic jitter.

## 8. Validate before running

Run:

```sh
ensemble validate
```

Validation does not dispatch tasks. It checks:

- Host YAML and absolute paths.
- Protected env-file ownership and permissions.
- Secret references.
- Git and configured runtime executables.
- Repository configuration and role names.
- Runtime lookup.
- Provider credentials, routing configuration and adapter prerequisites.

Success prints:

```text
Ensemble configuration is valid
```

For a deeper non-dispatching check, run:

```sh
ensemble doctor
```

`doctor` checks the configured filesystem, state directory, instance guard,
provider read access, repository configuration, runtime settings, and an actual
Codex App Server initialize plus account-state handshake. It does not start a
thread, create a turn, claim a task, or test provider write permissions.

Use the read-only operational commands when diagnosing a running or stopped
controller:

```sh
ensemble status
ensemble inspect task 32
ensemble inspect task 32 --journal
```

`status` reports the local controller PID/lock state and configured paths.
`inspect task` reconstructs the provider-owned execution state and reports the
active lease and terminal history. `--journal` adds ordered event metadata, but
never prints raw hidden comment bodies. Use `--repository <id>` when more than
one repository is registered. All three commands accept `--json`.

Common validation failures include:

- `configurationPath` still contains the generated placeholder.
- The path points to a file instead of a repository directory.
- `AGENTS.md`, `.ensemble/WORKFLOW.md`, `.ensemble/config.yaml`, or all role
  files are missing.
- `initialRole` does not match a role filename.
- The repository selects a runtime that is not registered by the host.
- Provider-specific routing identifiers or workflow-state prerequisites are
  wrong.
- The env file has permissions broader than allowed.

## 9. Prepare the first provider task

For an ordinary new task to be dispatchable, all of these must be true:

1. The provider returns it from the configured routing scope.
2. The adapter maps its native state to a repository `statuses.runnable` value.
3. The adapter marks it dispatchable after applying assignment, archive,
   routing, required-filter and blocker rules.
4. It is not waiting for a durable retry due time.
5. It is not protected by another controller's active lease.

For a first test, choose a small task without dependencies and put it in the
adapter's documented ready state. Do not manually apply every lifecycle state.
Ensemble asks the provider adapter to synchronize running, completed, failed
and blocked transitions. The exact native fields, labels or statuses are
documented in the selected provider guide.

## 10. Run in the foreground

Start the long-running controller:

```sh
ensemble run
```

Logs are JSON Lines written to the terminal. A healthy empty startup resembles:

```text
service.starting
repository.startup_started
scheduler.startup_completed
repository.startup_succeeded
service.running
scheduler.tick_completed
```

When an authenticated provider wake route is configured, startup also emits a
`webhook.server_started` JSON record containing its public `endpoint`. Use that
logged endpoint when configuring the provider; credentials are never logged.

`candidateCount: 0` means the provider call succeeded but no task satisfied all
eligibility rules. It is not itself a service error.

When a task is selected, useful events include:

```text
candidate.discovered
claim.succeeded
dispatch.started
dispatch.runtime_started
runtime.started
dispatch.completed
synchronization.completed
```

Stop the process with `Ctrl+C`. Ensemble stops intake, drains or cancels workers
within configured deadlines, synchronizes durable state where possible, and
releases its single-instance guard.

Only one controller may use a state directory at a time.

## 11. Run as a service

After foreground operation works:

```sh
ensemble service install
ensemble service start
ensemble service status
ensemble service logs
```

Management commands are:

```sh
ensemble service stop
ensemble service restart
ensemble service uninstall
```

On Linux, Ensemble installs a hardened systemd system unit running as the
dedicated `ensemble` user. Logs go to journald.

On macOS, Ensemble installs a user LaunchAgent. Logs go to
`~/Library/Logs/Ensemble`.

`service status` includes supervisor output plus the configured host, state and
workspace paths. Secrets are not included in generated service definitions or
status output.

## 12. Workspace and Git behavior

Each task receives an isolated directory below the configured workspace root:

```text
workspaces/
└── <repository-id>/
    └── <task-id>/
        ├── repository/
        └── .ensemble-runtime/
```

The `repository` directory is the agent's Git working copy. Workspaces are
preserved by default. Ensemble may restore a valid existing workspace after a
restart, while durable provider state determines which role and execution are
recovered.

Git is available to the runtime when included in its explicit environment.
Local commits may be requested by repository workflow instructions. Pushing is
not automatic. Operators may deliberately pass a repository-scoped
`SSH_AUTH_SOCK`, but provider credentials must never be made available to the
runtime.

Workspace cleanup is restricted to direct children of the configured absolute
workspace root.

## 13. Troubleshooting

### The CLI prints nothing

Confirm which executable is installed:

```sh
command -v ensemble
ensemble --help
```

Rebuild and reinstall the current package if the global executable is stale.

### Validation reports `/absolute/path/to/configuration-checkout`

The generated template has not been customized. Replace `configurationPath`
with the absolute path of the local repository checkout containing `AGENTS.md`
and `.ensemble`.

### `candidateCount` remains zero

Check, in order:

1. The adapter-specific routing identifiers.
2. The task's native provider state and archive/terminal state.
3. Assignment and required routing filters.
4. Unresolved portable blockers.
5. Whether the task is waiting for a retry.

Temporarily setting host logging to `debug` provides candidate-decision events:

```yaml
logging:
  level: debug
```

### The task is `ready` but does not run

`ready` describes the provider status. Dispatch also requires
`dispatchable: true`. Provider-native assignment filters, routing filters,
archive state and unresolved blockers can all make a ready task
non-dispatchable.

### The runtime cannot start

Verify:

- The host runtime registration follows its adapter-specific guide.
- The repository's runtime name exactly matches the host registration.
- Required authentication is available to the service account through the
  runtime adapter's documented mechanism.
- Required environment variables are explicitly allowlisted without exposing
  provider credentials.
- The service account can read the configuration checkout and write the state
  and workspace directories.
- Runtime-specific diagnosis follows the selected guide under `docs/runtimes/`.

### A stage repeatedly fails

Retries repeat the latest failed role. Inspect the task's execution comments,
structured logs, preserved workspace, role instructions, and configured
failure limits. Once `maxFailedAttemptsPerRole` is reached, further automatic
retries for that role are suppressed.

## 14. Adoption checklist

- [ ] Install the package and confirm `ensemble --help`.
- [ ] Run `ensemble init`.
- [ ] Select and follow a guide from `docs/providers/`.
- [ ] Store provider credentials only in the protected env file.
- [ ] Select and follow a guide from `docs/runtimes/`.
- [ ] Register the real repository URL, branch and configuration checkout.
- [ ] Register only the runtimes the repository needs.
- [ ] Create root `AGENTS.md`.
- [ ] Create `.ensemble/config.yaml` and `.ensemble/WORKFLOW.md`.
- [ ] Create at least one `.ensemble/roles/*.md` file.
- [ ] Make every intended role transition explicit in role instructions.
- [ ] Complete the adapter-specific routing and lifecycle-state setup.
- [ ] Run `ensemble validate`.
- [ ] Test an unblocked task in the provider's documented ready state using
  `ensemble run`.
- [ ] Verify the preserved workspace and durable provider transitions.
- [ ] Restart foreground Ensemble and confirm recovery behavior.
- [ ] Install the system service only after foreground operation succeeds.
