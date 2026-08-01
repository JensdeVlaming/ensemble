# Production-readiness assessment

Date: 2026-08-01

## Current conforming baseline

- `OrchestratorService` owns completion-relative recurring ticks, non-overlap,
  per-repository startup isolation, signal handling, and bounded shutdown.
- `Scheduler` owns deterministic discovery, role selection, capacity,
  provider claims and leases, active reconciliation, deadline enforcement,
  durable failure classification, deterministic retry due times, and restart
  reconstruction.
- `ExecutionEngine` returns non-blocking `RunningExecution` handles and owns
  runtime invocation, event consumption, cancellation, and attempt cleanup.
- `VikunjaProvider` is a runnable production adapter with paginated discovery,
  filtering, targeted refresh, read retry/rate-limit behavior, durable claims,
  leases, and idempotent complete/fail/cancel/block mutations.
- Repository configuration uses a full YAML parser, atomic multi-file revision
  capture, strict typed validation, hot reload, and last-known-good fallback.
- Host configuration, protected env-file parsing, credential redaction, minimal
  runtime environments, a single-instance guard, the compiled CLI, systemd and
  launchd adapters, structured JSONL logs, and npm tarball packaging exist.
- The current test suite has 146 deterministic tests and the clean baseline
  passes `npm test`, `npm run check`, and `npm run build`.

## Remaining normative gaps

### Runtime portability and blocked work

- `RuntimeContext` has no portable `tools` capability.
- `RuntimeEvent` lacks the provider execution ID and the portable approval,
  user-input, tool-elicitation, usage, rate-limit, and heartbeat variants from
  SPEC sections 11 and 12.
- `ExecutionEngine` tracks activity but does not surface a runtime blocking
  request as an execution result; `Scheduler` therefore never calls the
  existing `ProviderAdapter.blockExecution` path.
- Repository runtime configuration does not validate a documented operator
  request policy for capable runtimes.

### Production Codex transport

- Only `CodexCliTransport` exists. It launches one `codex exec --json` process
  and cannot keep an App Server connection/thread alive, bound continuation
  turns, respond to server requests, register host tools, or report protocol
  usage/rate-limit state.
- Host runtime registration accepts only `codex-cli`.
- The production transport must use the documented newline-delimited JSON-RPC
  handshake (`initialize`, `initialized`), `thread/start`, `turn/start`, turn
  notifications, `turn/interrupt`, server-initiated approval/input/elicitation
  requests, and experimental dynamic tool calls. Generated schemas are tied to
  the installed Codex version, so the client must validate only the stable
  portable subset and fail closed on malformed required fields.

### Provider-native Vikunja tools

- `ProviderAdapter` has no method that returns host-executed tool definitions.
- Vikunja credentials are currently isolated correctly, but agents consequently
  cannot perform provider-native reads or mutations through runtime tools.
- Tool input/output schemas, task scoping, bounded output, and mutation
  idempotency need explicit contracts and deterministic fakes.

### Workspace lifecycle

- Hook configuration parses, but no hook is executed.
- Restore verifies only that three direct paths are non-symlink directories. It
  does not verify the Git origin/branch or synchronize the configured upstream.
- Sanitized task IDs can collide. Creation and deletion rely mainly on lexical
  containment and do not fully defend every path against symbolic-link changes.
- Terminal reconciliation invokes attempt cleanup, but preserved workspaces and
  stale startup workspaces have no separate terminal cleanup policy or scan.

### Operational state and endpoints

- Structured logging exists, but `ServiceSnapshot` and its running, retrying,
  blocked, recent-error, usage, and rate-limit diagnostics do not.
- The CLI has no optional health/readiness/snapshot listener. An endpoint is
  optional in SPEC section 18, but section 19 requires it when configured.

### Release and conformance evidence

- The executable, npm package shape, tarball, and supervisor definitions exist.
  Registry publication and hosted releases are external side effects and are
  not authorized by this loop.
- There is no named v0.3 cross-component conformance suite, artifact secret scan,
  or real Linux/macOS install-process-restart acceptance record.
- Live-machine Linux systemd validation cannot be performed on this macOS host;
  deterministic unit/snapshot checks and reproducible external commands are the
  local completion boundary.
- Vikunja backlog tasks 26 and 29 describe work already completed; task 19 is
  partially complete. Backlog mutations wait until the corresponding delivery
  evidence is final.

## Immediate workflow defect

The repository's planner and implementation role instructions do not explicitly
require `nextRole` values. Since every non-terminal result requires a valid next
role, the production workflow instructions must name the planner to
implementation and implementation to reviewer transitions.

## Explicit exclusions

- Docker workers and bundled Codex images.
- Windows Service integration beyond clear unsupported behavior and foreground
  portability.
- A mutable dashboard or second control plane.
- Automatic Git push, PR creation, deployment, npm publication, or hosted
  release creation.
