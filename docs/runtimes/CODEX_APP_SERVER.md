# Codex App Server Runtime Guide

Codex App Server is Ensemble's Codex runtime transport. It keeps a bounded
thread alive across corrective turns, exposes claim-scoped provider tools,
handles operator requests, and reports usage and rate-limit events.

## Install and authenticate Codex

Install Codex, record its absolute path, and create a dedicated `CODEX_HOME`
that is readable and writable by the account running Ensemble:

```sh
command -v codex
mkdir -p "/absolute/path/to/ensemble-state/codex"
CODEX_HOME="/absolute/path/to/ensemble-state/codex" codex login
CODEX_HOME="/absolute/path/to/ensemble-state/codex" codex login status
```

Treat the contents of `CODEX_HOME` as credentials. Do not commit or copy its
authentication files into a repository.

## Register the host runtime

```yaml
runtimes:
  - name: codex
    type: codex-app-server
    executable: /absolute/path/to/codex
    serverArguments: [app-server, --listen, stdio://]
    requestTimeoutMs: 30000
    environment:
      inherit: [PATH, HOME, CODEX_HOME, TMPDIR, LANG, LC_ALL]
```

`serverArguments` are passed as an argv array. `requestTimeoutMs` bounds App
Server protocol requests. The child receives only the explicitly inherited
environment; provider credentials are forbidden.

## Select and configure the runtime

Repository configuration selects the logical host registration and controls
Codex execution policy:

```yaml
runtime:
  name: codex
  config:
    operatorRequests: reject
    approvalPolicy: never
    sandbox: workspace-write
    networkAccess: false
    maxTurns: 3
```

Supported settings are `operatorRequests`, `automaticApprovals`, `model`,
`effort`, `approvalPolicy`, `sandbox`, `networkAccess`, and `maxTurns`.
`operatorRequests` may be `auto`, `reject`, or `block`. Use `block` when an
unattended workflow should persist requests for later operator action.

## Provider tools

After the Scheduler durably claims a task, it supplies execution-scoped tools
to the Runtime. App Server publishes them as dynamic tools and routes calls
back through Ensemble without exposing provider credentials. A tool is revoked
when the execution loses its lease or finishes.

For Vikunja these include reading the claimed task, comments, and artifacts and
adding an idempotent visible task comment. Hidden Ensemble state comments are
the provider execution journal and must not be edited manually.

## Validate and run

```sh
ensemble validate
ensemble doctor
ensemble run
```

`ensemble doctor` starts App Server only long enough to perform `initialize`,
send `initialized`, and read the configured account state. It does not create a
thread or turn. A successful account check confirms that the selected Codex
home has an account when the active provider requires OpenAI authentication;
it does not consume a model request.

A healthy execution progresses through `runtime.prepared`, `runtime.started`,
`runtime.completed`, and `synchronization.completed`. Failures before
`runtime.started` indicate App Server startup or authentication problems;
failures after `runtime.completed` indicate provider synchronization problems.

## Troubleshooting

- Confirm the configured executable exists and supports `codex app-server`.
- Run `codex login status` with the exact configured `CODEX_HOME`.
- Use App Server sandbox mode values `workspace-write`, `read-only`, or
  `danger-full-access`. Ensemble translates these to the separate camel-cased
  sandbox-policy representation used by turns.
- Use `operatorRequests: block` when approval or input requests should move the
  task to Ensemble's blocked status instead of being rejected.
- Do not remove hidden provider-state comments while Ensemble is running.
