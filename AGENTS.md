# Ensemble repository instructions

## Mission and scope

- Treat `SPEC.md` as the authoritative product and architecture contract.
- Ensemble orchestrates work; it does not own project management, source
  control, CI, deployment, or the software changes produced by agents.
- Do not add production provider adapters, deployment infrastructure, UI, or
  unrelated features unless the user explicitly expands the scope.
- Deliver working, verified changes rather than stopping at analysis or a plan.
  Make reasonable assumptions and ask only when a material decision cannot be
  discovered safely from the repository.

## Architecture boundaries

- Preserve the dependency direction:
  `ProviderAdapter -> Scheduler -> ExecutionEngine -> Runtime`.
- The Scheduler determines what runs. It owns deterministic candidate ordering,
  eligibility, role selection, retry policy, recovery decisions, provider
  context reads, and durable provider lifecycle transitions.
- The Execution Engine determines where work runs. It owns workspace allocation
  and restoration, repository configuration loading, runtime invocation, event
  consumption, cancellation, and cleanup. It must not depend on providers or
  contain scheduling or runtime-specific policy.
- A Runtime determines how work runs. Context and prompt construction,
  runtime-specific configuration, process/protocol handling, event parsing,
  structured-result generation, resume, and cancellation stay behind `Runtime`.
- Provider-specific assignment, status, archive, metadata, and persistence
  mapping stay behind `ProviderAdapter`. Code outside an adapter must never
  interpret provider metadata keys.
- Provider and repository state are durable sources of truth. In-process sets,
  sessions, handles, heartbeats, and workspace paths are ephemeral and must not
  be required for restart reconstruction.

## Source layout

- Put portable domain contracts in `src/domain/`.
- Put orchestration policy in `src/orchestration/` and workspace/repository
  lifecycle in `src/execution/`.
- Keep shared provider contracts in `src/providers/provider.ts`; place each
  adapter in its own `src/providers/<provider>/` directory.
- Keep the shared runtime contract in `src/runtimes/runtime.ts`; place each
  runtime and its transports in `src/runtimes/<runtime>/`.
- Keep Codex-specific code inside `src/runtimes/codex/`. Scheduler and Execution
  Engine code must not import Codex types or parse Codex records.
- Preserve the stable public surface through `src/index.ts`; avoid exposing
  internal storage or process representations.

## Implementation standards

- Read enough surrounding code and search for existing helpers before editing.
  Prefer `rg` and `rg --files` for repository exploration.
- Prefer focused, coherent patches that solve the root cause. Reuse existing
  abstractions instead of adding parallel pathways or speculative layers.
- Use strict TypeScript and dependency-free Node.js APIs where practical.
  Prefer types, validation, and guards over casts; do not use `any` to bypass a
  contract.
- Keep provider state reads validated, deterministically ordered, defensively
  copied, and immutable at the adapter boundary.
- Keep scheduler behavior deterministic. Sort provider candidates explicitly
  and derive retry/recovery state from provider history, never hidden counters.
- Active durable executions take precedence over ordinary status and retry
  eligibility and reuse their provider execution ID with a fresh runtime.
- Treat execution environments as callback-scoped, single-use capabilities.
  Cleanup is best-effort and must not replace a primary provider, runtime, or
  event failure.
- Avoid broad catches, silent success-shaped fallbacks, and indefinite waits.
  Surface invalid inputs and failures through the repository's typed contracts.
- Use argv arrays for child processes; never construct shell command strings.
  Do not hard-code credentials or secrets, and never store secrets in `.ensemble`.
- Add comments only when they explain a non-obvious invariant or tradeoff.

## Tools and change discipline

- Prefer dedicated tools over shell equivalents. Use `apply_patch` for manual
  source edits and parallelize independent reads or checks when useful.
- Preserve unrelated user changes. Do not use destructive Git commands.
- Do not commit, push, create a branch, or open a pull request unless requested.
- When a pull request is requested, use the GitHub integration rather than the
  `gh` CLI.
- Branch names must follow Conventional Branch v1.1.0:
  `<type>/<lowercase-hyphenated-description>`, where type is `feature`, `feat`,
  `bugfix`, `fix`, `hotfix`, `release`, or `chore`.

## Verification

- Run `npm test` and `npm run check` before considering a code change complete.
- Add focused tests for every changed architectural behavior and its meaningful
  failure, retry, cancellation, or restart path.
- Prefer deterministic fakes for provider, process, and transport tests. Unit
  tests must not require network access or real Codex/provider credentials.
- For scheduler changes, test ordering, role selection, retries, active recovery,
  atomic synchronization, and reconstructed-Scheduler behavior as applicable.
- For execution changes, test allocation/configuration failures, callback
  rejection, single-use/closed environments, cleanup, and event/result races.
- For provider changes, test candidate filtering, state validation and copying,
  lifecycle idempotency, and malformed provider data.
- For runtime transports, test argv, chunked stream parsing, malformed records,
  non-zero exits, cancellation, resume, and structured-result validation.

## Completion

- Re-read the user request and `SPEC.md`, inspect the final diff or changed
  files, and confirm the implementation stays inside the requested scope.
- Report the outcome, important architectural decisions, verification results,
  and any genuine remaining limitation concisely.

Prompting reference: https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
