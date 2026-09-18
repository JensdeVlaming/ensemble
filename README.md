# Ensemble

Ensemble is a small, runtime- and provider-independent orchestration core for
autonomous software engineering agents. The task provider owns workflow state;
Ensemble retains only ephemeral process and workspace state.

New adopters should start with the detailed [Starter Guide](docs/STARTER_GUIDE.md).

## Requirements

- Node.js 22.6 or newer
- Git for repository workspace materialization
- A configured task-provider adapter; see the [provider guides](docs/providers/README.md)
- Any executable or endpoint required by a selected optional runtime; see the
  [runtime guides](docs/runtimes/README.md)

## Run Ensemble continuously

Ensemble ships a compiled `ensemble` CLI. Linux with systemd is the primary
service platform; macOS launchd is also supported. Windows can use foreground
mode where its Node.js dependencies work, but Windows Service installation is
not included.

Build and install the local package:

```sh
npm install
npm run build
npm pack
npm install --global ./ensemble-0.1.0.tgz
```

Initialize platform-default configuration, edit the generated YAML and protected
environment file, validate it without dispatching work, then install the service:

```sh
ensemble init
ensemble validate
ensemble doctor
ensemble status
ensemble inspect task <id>
ensemble service install
ensemble service start
ensemble service status
ensemble service logs
```

On Linux these setup commands use `/etc/ensemble` and `/var/lib/ensemble` and
must be run with the permissions required to create the dedicated `ensemble`
system user and systemd unit. On macOS they use `~/Library/Application Support/Ensemble`
and install a user LaunchAgent. `ensemble run` runs the identical service in the
foreground on either platform. `SIGINT` and `SIGTERM` stop intake, drain live
workers within repository bounds, persist cancellations, and release the
single-instance guard.

`ensemble doctor` performs non-dispatching filesystem, provider,
repository-configuration, Codex App Server initialization, and Codex account
checks. `ensemble status` reads the local instance guard without contacting the
provider. `ensemble inspect task <id>` reconstructs durable provider state;
add `--journal` for safe ordered event metadata or `--json` for automation.
Raw hidden provider comments are never emitted.

The protected environment file is deliberately not shell syntax:

```text
TASK_PROVIDER_TOKEN=replace-me
```

It must be a regular non-symlink. macOS and same-owner Linux files require mode
`0600`; a root-owned Linux file may be mode `0640` when its group is the
`ensemble` service group. Secrets are resolved only by the controller and are
registered with structured-log redaction.

Host configuration is separate from repository-owned `.ensemble` workflow
configuration. A complete registration has this shape:

```yaml
version: 1
service:
  startupTimeoutMs: 30000
  stopTimeoutSeconds: 60
logging:
  level: info
workspace:
  root: /var/lib/ensemble/workspaces
  preserve: true
  gitExecutable: /usr/bin/git
runtimes:
  - name: agent-runtime
    # Replace with the exact block from docs/runtimes/ for the selected
    # adapter.
    type: runtime-specific
repositories:
  - id: ensemble
    url: https://github.com/example/ensemble.git
    branch: main
    configurationPath: /srv/ensemble
    provider:
      # Replace with the exact block from docs/providers/ for the selected
      # adapter.
      type: provider-specific
```

The package includes a Vikunja example at `examples/host-config.yaml`, an Azure
DevOps Services example at `examples/host-config.azure-devops.yaml`, and the
matching non-secret `examples/azure-devops.env.example` template. Follow the
dedicated
[Vikunja guide](docs/providers/VIKUNJA.md),
[Azure DevOps guide](docs/providers/AZURE_DEVOPS.md), and
[Codex App Server guide](docs/runtimes/CODEX_APP_SERVER.md) for exact adapter fields.

Polling, worker, retry, turn, stall, cancellation, and drain bounds remain in
the repository-owned workflow configuration so they hot-reload atomically with
the workflow they govern. Host logging level and supervisor stop bounds live in
the host file.

Runtime registrations are optional. A repository selecting a runtime is
rejected during validation unless a host runtime with that logical name exists.
Runtime children receive only the explicitly allowlisted environment.
Credential-like variables and all provider credential variables are rejected
even if an operator attempts to allowlist them. Authentication and protocol
setup are documented separately for each runtime.

Git is available inside preserved task workspaces, so repository workflow
instructions may request local commits. Pushing is opt-in. Passing
`SSH_AUTH_SOCK` gives the runtime access to that agent socket and should only be
done with a dedicated repository-scoped key. Ensemble itself does not own
commits, pushes, pull requests, CI, or deployment.

## Run the tests

```sh
npm install
npm test
npm run check
```

## Architecture

```text
src/
├── domain/                 portable data contracts
├── providers/
│   ├── provider.ts         provider adapter contract
│   ├── memory/             reference adapter
│   ├── vikunja/            production Vikunja API v1 adapter
│   └── azure-devops/       production Azure DevOps Services adapter
├── orchestration/          deterministic scheduling policy
├── execution/              workspace and runtime lifecycle
└── runtimes/
    ├── runtime.ts          common runtime contract
    ├── scripted/           test/reference runtime
    └── codex/              Codex runtime and App Server transport
```

- `Scheduler` polls semantic workflow candidates, deterministically orders them,
  resolves repository-defined roles, applies per-role retry policy, and owns all
  durable provider transitions.
- `ExecutionEngine` owns callback-scoped disposable workspaces, configuration
  loading, runtime invocation, event streaming, cancellation, and cleanup. It
  contains no provider or scheduling policy.
- `Runtime` turns a complete `RuntimeContext` into a session of portable events
  and a structured result.
- `ProviderAdapter` is the only layer that understands an external task system.
- `RepositoryConfigLoader` reads `.ensemble/config.yaml`, `WORKFLOW.md`, role
  files, and `AGENTS.md`.

Repository configuration uses strict YAML 1.2. Nested mappings, block and flow
lists, quoted strings, multiline strings, anchors, and bounded aliases are
supported. Duplicate keys, multiple documents, custom or explicit tags, merge
keys, cyclic/excessive aliases, non-mapping roots, and prototype-sensitive keys
are rejected before typed configuration validation.

The loader captures `config.yaml`, `WORKFLOW.md`, `AGENTS.md`, and the complete
sorted role set twice before accepting a revision. `RepositoryConfigurationManager`
atomically installs only a stable, fully validated revision and retains the
exact last-known-good object when a later revision is invalid. The long-running
service reloads through the Scheduler's own execution service before every
tick, so reload and dispatch cannot be wired to different configuration stores.
Valid polling and shutdown bound changes apply to subsequent service operations;
already-running workers retain the immutable revision captured at dispatch.

Repository text is never subject to environment substitution. Host configuration
may resolve explicitly documented `$NAME` secret references with
`HostSecretResolver`; missing or empty values fail validation, and every value
resolved through that instance is removed from reload diagnostics. Secrets must
remain deployment inputs and must not be written into `.ensemble`.

The stable public API is re-exported from `src/index.ts`. `InMemoryProvider` and
`ScriptedRuntime` are executable reference adapters suitable for tests and local
experiments. `GitRepositoryDriver` materializes isolated repository checkouts.
Concrete runtime behavior and setup are documented in the
[runtime guides](docs/runtimes/README.md).

Provider adapters expose durable execution history through
`getExecutionState`. `discoverTasks({ scope: "workflow_candidates" })` means the
adapter applies provider-specific assignment, archive, and terminal filters
before the Scheduler allocates a workspace.

## Task providers

Provider adapters have separate installation and task-preparation instructions.
See the [task-provider guides](docs/providers/README.md), including the detailed
[Vikunja](docs/providers/VIKUNJA.md) and
[Azure DevOps](docs/providers/AZURE_DEVOPS.md) guides. Provider-specific
operational setup is kept out of the Starter Guide.

## Repository retry policy

Retry behavior is repository-owned:

```yaml
retry:
  maxFailedAttemptsPerRole: 3
```

The value counts failed executions separately for each role. It defaults to
`3`; `0` still permits a task's initial execution but disables retries. Durable
active executions always recover with their provider-stored role and execution
ID, regardless of status or retry exhaustion.

## Runtimes

Runtime adapters have separate installation, authentication, environment and
protocol instructions. See the [runtime guides](docs/runtimes/README.md),
including the detailed [Codex App Server guide](docs/runtimes/CODEX_APP_SERVER.md). The main
Starter Guide describes only the shared Runtime contract and portable role
lifecycle; adapter-specific setup stays in its runtime guide.

## Operational logs

Ensemble components accept an optional `OperationalEventReporter`. The built-in
`StructuredLogger` turns stable lifecycle events into immutable records with a
timestamp, service instance ID, and available provider, repository, task, role,
and execution correlation IDs. `JsonLinesOperationalLogSink` writes one JSON
object per line to an injected writable.

Logging is best-effort: throwing or rejecting reporters, sinks, and redactors
never change orchestration outcomes. Records use a closed event catalog and
allowlisted data fields. Correlations and strings are UTF-8 bounded, nested
values have fixed depth and width limits, and a complete record never exceeds
8,192 JSON-encoded bytes. Unknown, cyclic, excessive, or unsupported values are
replaced with deterministic truncation markers.

Provider credentials, authorization values, prompts, raw runtime messages,
tool names and arguments, results, request and response bodies, error messages,
and stacks are not part of component projections. Hosts may additionally pass
`HostSecretResolver.redact` to `StructuredLogger` so resolved deployment secret
values are removed before a sink can observe a record.
