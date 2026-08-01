# Codex CLI Runtime Guide

This guide configures Ensemble's Codex runtime using the local `codex exec
--json` transport. Complete the provider-neutral [Starter
Guide](../STARTER_GUIDE.md) first, then use this guide for Codex installation,
authentication, host registration and repository runtime selection.

## 1. What the runtime owns

The Codex runtime:

- Converts Ensemble's portable runtime context into a Codex prompt.
- Includes the task, comments, artifacts, repository instructions, shared
  workflow instructions and selected role instructions.
- Starts `codex exec --json` using an argv array rather than a shell command.
- Normalizes supported Codex JSONL records into portable runtime events.
- Extracts and validates a structured `RuntimeResult` from the final agent
  message.
- Retains the Codex thread ID for supported continuation calls.
- Cancels the active Codex child process when Ensemble reconciles or times out
  work.

Codex-specific code remains behind the Runtime boundary. Scheduler and
Execution Engine code do not parse Codex records or construct Codex prompts.

## 2. Install Codex CLI

Install Codex CLI using the official installation method for the target host,
then find its absolute path:

```sh
command -v codex
```

The host configuration requires that absolute path. Examples include:

```text
/usr/local/bin/codex
/opt/homebrew/bin/codex
/Users/example/.local/bin/codex
```

Do not assume that an interactive shell's `PATH` is available to systemd or
launchd.

## 3. Create a dedicated Codex home

Codex authentication should live in a dedicated directory accessible to the
account running Ensemble.

Typical macOS env-file value:

```text
CODEX_HOME=/Users/example/Library/Application Support/Ensemble/state/codex
```

Typical Linux system-service value:

```text
CODEX_HOME=/var/lib/ensemble/codex
```

Authenticate Codex using that home and the same operating-system account that
will run Ensemble. For Linux system services, this is the dedicated `ensemble`
account and the directory must be owned or writable by that account.

Do not pass an OpenAI API key through the runtime environment. Ensemble rejects
credential-shaped allowlist names. The supported deployment model is an
authenticated `CODEX_HOME` that contains Codex's own local authentication
state.

## 4. Register Codex on the host

Add a runtime entry to host `config.yaml`:

```yaml
runtimes:
  - name: codex
    type: codex-cli
    executable: /absolute/path/to/codex
    executionArguments: [--sandbox, workspace-write, --skip-git-repo-check]
    environment:
      inherit: [PATH, HOME, CODEX_HOME, TMPDIR, LANG, LC_ALL]
```

Fields:

| Field | Meaning |
|---|---|
| `name` | Logical runtime name selected by repository configuration |
| `type` | Must be `codex-cli` for this transport |
| `executable` | Absolute executable path |
| `executionArguments` | Arguments inserted after `codex exec --json` and before repository runtime arguments and the prompt |
| `environment.inherit` | Exact controller variables copied into the Codex child |

Only the allowlisted environment is passed. The controller environment is not
inherited wholesale.

### Minimal child environment

Common safe variables are:

```yaml
environment:
  inherit: [PATH, HOME, CODEX_HOME, TMPDIR, LANG, LC_ALL]
```

Add `SSH_AUTH_SOCK` only when agents are intentionally allowed to use a
dedicated repository-scoped SSH agent:

```yaml
environment:
  inherit: [PATH, HOME, CODEX_HOME, TMPDIR, LANG, LC_ALL, SSH_AUTH_SOCK]
```

This may grant source-control access to the agent. It should be an explicit
operator decision. Provider tokens and other API credentials remain forbidden.

### Execution arguments

`executionArguments` configures process-level Codex flags. The recommended
local workspace setup is:

```yaml
executionArguments: [--sandbox, workspace-write, --skip-git-repo-check]
```

Arguments are passed directly; shell quoting, interpolation and command
composition are not used.

## 5. Select Codex in the repository

In `.ensemble/config.yaml`:

```yaml
runtime:
  name: codex
  config: {}
```

The name must exactly match the host registration.

### Optional model selection

The current CLI transport recognizes `runtime.config.model`:

```yaml
runtime:
  name: codex
  config:
    model: configured-model-name
```

It becomes an explicit `--model configured-model-name` argv pair. Omitting the
field leaves model selection to the authenticated Codex configuration and CLI
defaults.

Process flags such as the sandbox belong in host `executionArguments`; a
repository `runtime.config.sandbox` value is not translated into Codex CLI argv
by the current transport.

## 6. How roles reach Codex

For each selected role, the runtime context includes:

- Repository identity and URL.
- Task title, description and acceptance criteria.
- Provider-visible comments and artifacts.
- Workspace paths.
- Root `AGENTS.md` instructions.
- `.ensemble/WORKFLOW.md` instructions.
- The selected `.ensemble/roles/<role>.md` instructions.
- Repository runtime configuration.

The Codex prompt instructs the agent to execute one workflow role and return a
structured result. Roles use the same Codex runtime registration unless another
repository selects a different logical runtime.

The role instruction should state its intended transition. For example:

```markdown
When implementation and tests are complete, return a non-terminal structured
result with `nextRole: reviewer`.
```

## 7. Required structured result

The final Codex agent message must contain a JSON object equivalent to:

```json
{
  "outcome": "implemented",
  "summary": "Implemented the requested behavior and ran the tests.",
  "nextRole": "reviewer",
  "comments": [],
  "artifacts": []
}
```

Requirements:

- `outcome` is a string.
- `summary` is a string.
- `nextRole`, when present, is a string matching an existing role.
- `comments` is a string array.
- `artifacts` is an array of valid artifact objects.

Non-terminal outcomes require `nextRole`. Terminal outcomes such as `approved`
or `completed` do not require another role.

Free-form prose outside a valid final structured result cannot determine
orchestration success.

## 8. Process and session behavior

The initial turn uses an invocation equivalent to:

```text
codex exec --json <executionArguments> [--model <model>] <prompt>
```

Continuation uses the Codex thread ID through `codex exec resume --json`.
Ensemble parses the JSONL stream, observes process exit, and requires both a
thread-start record and final agent message.

Malformed JSONL, explicit Codex errors, missing thread identity, missing final
messages and non-zero process exits fail the runtime attempt. Scheduler retry
policy then decides whether and when that role runs again.

Cancellation sends `SIGTERM` to the active child and observes process exit.
Repository runtime-start, turn, stall and cancellation deadlines prevent an
uncooperative process from consuming capacity indefinitely.

## 9. Validate and run

Run:

```sh
ensemble validate
```

Validation confirms that:

- The Codex executable exists and is executable.
- The repository selects a registered runtime name.
- Host and repository configuration parse successfully.

Then run in the foreground:

```sh
ensemble run
```

Useful runtime events include:

```text
runtime.prepare_started
runtime.prepared
runtime.start_started
runtime.started
runtime.event
runtime.completed
```

## 10. Troubleshooting

### The executable is not found

Use `command -v codex`, copy the absolute result into host configuration, and
rerun `ensemble validate`. A path that works only through an interactive shell
alias is not sufficient.

### Codex is not authenticated

Confirm `CODEX_HOME` is present in the protected env file and in
`environment.inherit`. Authenticate that exact directory as the account that
runs Ensemble. Confirm the service account can read it.

### Codex cannot run Git or repository tools

Ensure the required executable directories are present in the allowlisted
`PATH`. Remember that the Codex child receives only the selected environment,
not the complete terminal environment.

### The task fails with no structured result

Strengthen `WORKFLOW.md` and role instructions to require the exact result
shape. Confirm the final agent message is JSON with `outcome`, `summary`,
`comments`, `artifacts`, and `nextRole` for non-terminal stages.

### The requested next role is rejected

The returned `nextRole` must exactly match a `.ensemble/roles/*.md` filename
without its `.md` suffix.

### The runtime times out or stalls

Inspect preserved workspace state and structured logs. Adjust repository
`timeouts.runtimeStartMs`, `timeouts.turnMs`, `timeouts.stallMs`, and
`timeouts.cancellationMs` only after determining whether the process is making
legitimate progress.

## 11. Current scope

This release uses one-shot Codex CLI processes with JSONL output. Codex App
Server, interactive approval handling, provider-native dynamic tools and richer
usage/rate-limit telemetry are separate future runtime work.

## 12. Codex adoption checklist

- [ ] Install Codex CLI and record its absolute executable path.
- [ ] Create a dedicated `CODEX_HOME`.
- [ ] Authenticate as the account that will run Ensemble.
- [ ] Register `type: codex-cli` in host configuration.
- [ ] Allowlist only required safe environment variables.
- [ ] Put sandbox and other process flags in `executionArguments`.
- [ ] Select the same logical runtime name in `.ensemble/config.yaml`.
- [ ] Optionally select a model through `runtime.config.model`.
- [ ] Make role transitions and the structured result shape explicit.
- [ ] Run `ensemble validate` and then test in foreground mode.
