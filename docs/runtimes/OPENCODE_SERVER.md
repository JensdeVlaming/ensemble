# OpenCode Server Runtime Guide

OpenCode Server is Ensemble's OpenCode runtime transport. Each execution gets
an isolated loopback server process, a correlated session and, when provider
tools are available, an execution-scoped MCP bridge.

## Install and authenticate OpenCode

Install OpenCode for the account that runs Ensemble and authenticate it before
starting the controller:

```sh
command -v opencode
opencode auth login
opencode auth list
```

OpenCode stores authentication under its XDG data directory. Treat that data as
credentials. Do not copy it into a repository or add provider API keys to the
runtime environment.

## Register the host runtime

```yaml
runtimes:
  - name: opencode
    type: opencode-server
    executable: /absolute/path/to/opencode
    serverArguments: [serve, --pure]
    requestTimeoutMs: 30000
    environment:
      inherit: [PATH, HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR, LANG, LC_ALL]
```

The host registration selects the installed executable and process settings.
OpenCode binds only to loopback on a runtime-selected ephemeral port. Ensemble
does not pass API keys or provider credentials to the child. It generates a
one-time server password for each process and authenticates every local HTTP
and event-stream request; the password is never persisted or logged.

## Select the model and policy

The repository selects the logical runtime and optionally an OpenCode model:

```yaml
runtime:
  name: opencode
  config:
    model: openai/gpt-5.6-sol
    operatorRequests: reject
```

`model` is optional and must use OpenCode's `provider/model` form. Ensemble does
not maintain a model allowlist; when omitted, OpenCode chooses its configured
default. Supported settings are `model`, `operatorRequests` and
`automaticApprovals`. `operatorRequests` may be `auto`, `reject` or `block`.
Automatic approval is limited to exact permission names listed in
`automaticApprovals`; questions are never automatically answered.

## Provider tools

After a durable claim, Ensemble starts a random-capability MCP endpoint on
`127.0.0.1` and dynamically registers it with that execution's OpenCode server.
Tool callbacks and provider credentials remain in the Ensemble parent process.
Closing, cancelling or losing the execution closes the bridge and revokes the
capability. The per-execution OpenCode process prevents registrations leaking
between tasks.

## Validate and run

```sh
ensemble validate
ensemble doctor
ensemble run
```

`ensemble doctor` starts OpenCode only long enough to call
`GET /global/health`; it creates no OpenCode session and dispatches no model
request. Authentication failures encountered during execution include the
`opencode auth login` recovery instruction.

## Troubleshooting

- Confirm the executable supports `opencode serve --pure`.
- Run `opencode auth list` as the same account and with the same XDG paths used
  by the Ensemble service.
- Confirm the configured model uses `provider/model`, for example
  `openai/gpt-5.6-sol`.
- Use `operatorRequests: block` when permissions or questions should move the
  task to Ensemble's durable blocked status.
- Do not expose the loopback MCP capability URL in logs or configuration.
