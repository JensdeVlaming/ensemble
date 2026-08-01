# Production readiness handoff after milestone 6

## Current state

Milestones 1 through 6 are implemented, independently reviewed, verified, and
committed. The production-readiness goal remains active because milestones 7
and 8 are intentionally deferred.

Latest milestone commit: `feat(orchestration): clean terminal workspaces`

The complete loop history, review revisions, and accepted milestone boundaries
are recorded in `run-log.md`, `state.json`, and `plan.md` in this directory.

## Milestone 7 — immutable snapshots and read-only endpoints

Implement the accepted plan without changing workflow truth ownership:

1. Add deeply immutable, bounded diagnostic contracts matching SPEC section 18.
2. Have Scheduler publish live execution state and provider-derived diagnostic
   state. Retry and blocking state must reconstruct from durable provider data;
   usage and rate-limit aggregates may remain bounded and ephemeral.
3. Have Orchestrator compose repository snapshots after startup and every tick,
   including lifecycle, readiness, last tick, configuration revision, and
   degradation. Partial diagnostics retain last-known data and never become
   eligibility truth.
4. Add optional loopback-by-default HTTP service exposing only `GET /health`,
   `GET /ready`, and `GET /snapshot`. Bound response size and shutdown; reject
   all other routes/methods; never add mutation endpoints.
5. Test restart reconstruction, resolution removal, lifecycle transitions,
   mutation resistance, bounds/redaction, degradation, listen failures, and
   graceful close.
6. Run the full verification suite, obtain an independent delivery pass, then
   commit exactly: `feat(observability): add snapshots and health endpoints`.

## Milestone 8 — conformance, documentation, and release acceptance

1. Fix and verify planner/implementation role transitions.
2. Update generic and provider/runtime-specific guides for App Server,
   operator resolution, task tools, workspaces, snapshots/endpoints, upgrade
   compatibility, and runtime requirements.
3. Add a named v0.3 conformance entry combining deterministic provider,
   Scheduler, Engine, Runtime, workspace, restart, blocking, snapshot, and
   shutdown scenarios with no credentials or network.
4. Add argv-safe release verification: build, pack dry-run, tarball manifest,
   configured sentinel scan, service-manager snapshots, and Node metadata.
   Never scan or print a real env file.
5. Produce `compliance-report.md` mapping specification MUSTs to evidence and
   list only genuine external acceptance: Linux/macOS service installation,
   package/release publication, and one real Vikunja/Codex run.
6. Reconcile stale Vikunja backlog tasks only after repository evidence exists;
   never copy credentials into task comments.
7. Run the final gate (`npm test`, `npm run check`, build, pack dry-run,
   credential-safe artifact scans, `git diff --check`), obtain an independent
   pass over the complete commit range, and commit exactly:
   `test: add v0.3 production conformance suite`.

## Important invariants to preserve

- Dependency direction remains ProviderAdapter → Scheduler → ExecutionEngine →
  Runtime.
- Provider/repository durable state remains workflow truth; snapshots and HTTP
  are observational only.
- Partial/unreadable provider inventory never authorizes absence-based deletion.
- Active/synchronizing workspaces remain owned until runtime and durable
  transitions settle.
- Workspace paths never cross into Scheduler or provider contracts.
- Provider credentials never enter runtimes, prompts, workspaces, logs, tests,
  release artifacts, or handoff documents.
- Every milestone requires focused failure/restart tests, all repository checks,
  and an independent reviewer pass before commit.
