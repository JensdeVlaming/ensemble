# Run `ensemble-production-readiness` In This Session

Use this prompt when the user wants to run the Looper-designed loop in the current LLM session.
This is the default/easy execution path. The Python runner is the advanced path for running later or outside the session.

## Operator Instructions

You are executing a Looper-designed loop in this current session.
Follow the resolved spec below, write handoff files into the workspace, and enforce the caps manually.
Do not use `run-loop.py` unless the user explicitly asks for the advanced external runner.

1. Create the workspace directory if it does not exist.
2. Read the context sources before drafting the plan.
3. Draft `plan.md` in the workspace.
4. Run the plan gate. Apply programmatic checks when available. For judge criteria, use the configured judge only after consent for any non-local egress; otherwise ask the user to approve a human/current-session substitute.
5. Revise until the gate passes or `max_revisions` is reached.
6. Produce `delivery-N.md` in the workspace.
7. Run the delivery gate after each delivery.
8. Stop when all delivery criteria pass, a cap is reached, or the user stops the loop.
9. Keep `state.json` current with status, iteration, last gate, consent, and blockers.
10. Append a compact entry to `run-log.md` after every context read, model call, check, gate verdict, revision, blocker, and stop decision.
11. Compare each blocker against the previous blocker. If the same blocker repeats for the configured no-progress window, stop or ask for the configured human checkpoint instead of revising again.
12. Treat token and USD budgets as operator limits in this session: if exact accounting is unavailable, stop and ask before continuing when the loop appears likely to exceed them.

## Files

- Source spec: `loop.yaml`
- Human summary: `LOOP.md`
- Resolved spec: `loop.resolved.json`
- Workspace: `./production-loop-workspace`
- State file: `state.json`
- Run log: `run-log.md`

## Goal

Bring Ensemble from its current usable Vikunja and Codex CLI service to the production-ready state required by SPEC.md: portable runtime tools and operational events, Codex App Server support, resumable blocked work, credential-safe Vikunja-native tools, complete workspace lifecycle and containment, immutable operational snapshots and read-only endpoints, accurate operator documentation and backlog state, deployable release artifacts, and conformance evidence. Implement and commit coherent dependency-ordered milestones without weakening provider/runtime boundaries, durable provider truth, secret isolation, or cross-platform behavior.

## Definition Of Done

Every in-scope MUST requirement in SPEC.md has implementation and focused deterministic test evidence; Codex CLI remains an optional fallback while App Server supports continuation, tools, approvals, input, usage, and rate events; blocked work round-trips durably through ProviderAdapter; Vikunja tools execute on the host without credential egress; workspace hooks, restore verification, refresh, containment, and cleanup are bounded and safe; immutable snapshots and configured read-only health/status endpoints expose no secrets; npm test, npm run check, npm run build, npm pack --dry-run, git diff --check, artifact credential scans, and the v0.3 conformance suite pass; Linux and macOS service artifacts are verified, with any real-host or publication step that cannot be performed locally documented as an external acceptance item; each milestone is independently judged and committed.

## Context Sources

- Read file `../SPEC.md`
- Read file `../AGENTS.md`
- Read file `../README.md`
- Read file `../package.json`
- Read file `../.ensemble/config.yaml`
- Run command `["rg", "--files", "../src", "../tests", "../docs", "../examples"]`
- Run command `["git", "status", "--short"]`

## Verification Criteria

- `tests` programmatic: run `["npm", "--prefix", "..", "test"]` and expect `exit_zero`
- `types` programmatic: run `["npm", "--prefix", "..", "run", "check"]` and expect `exit_zero`
- `build` programmatic: run `["npm", "--prefix", "..", "run", "build"]` and expect `exit_zero`
- `diff-integrity` programmatic: run `["git", "-C", "..", "diff", "--check"]` and expect `exit_zero`
- `milestone-traceability` judge rubric: Review the current milestone plan or delivery against SPEC.md and the production-readiness goal. Every claim must cite observable source or deterministic test evidence. Blocking issues include missing required behavior, incomplete failure/restart/cancellation coverage, stale public contracts or documentation, unbounded waits, and unsupported compliance claims. External-only release or second-platform operations may remain only when clearly documented with reproducible acceptance steps.

- `architecture-and-security` judge rubric: Provider-specific behavior and credentials remain behind ProviderAdapter and host tool handlers; runtime-specific protocol stays behind Runtime; orchestration policy remains in Scheduler; workspace ownership remains in ExecutionEngine; durable state remains provider owned. Runtime processes, prompts, workspaces, logs, snapshots, build artifacts, and review artifacts must not contain provider credentials. Any cross-layer leakage, unsafe path handling, shell command construction, or hidden durable controller state is blocking.

- `test-quality` judge rubric: Each changed behavior has focused deterministic tests for success and meaningful malformed, timeout, cancellation, retry, restart, or cleanup behavior as applicable. Tests must assert externally meaningful contracts and must not require network access, a real provider, or real Codex credentials.


## Council

- `independent-judge` judge via `["codex", "exec", "--ignore-user-config", "--sandbox", "read-only", "--add-dir", ".."]` (non-local; timeout 1200s)

## Gates

### plan_gate

- When: `after_plan`
- Policy: `revise_until_clean`
- Verdict source: `independent-judge`
- Criteria: `milestone-traceability, architecture-and-security`
- Max revisions: `3`

### delivery_gate

- When: `after_each_delivery`
- Policy: `revise_until_clean`
- Verdict source: `independent-judge`
- Criteria: `tests, types, build, diff-integrity, milestone-traceability, architecture-and-security, test-quality`
- Max revisions: `3`

## Loop Control

- Max iterations: `16`
- Budget: `{"tokens": 2000000, "wall_clock_min": 480}`
- No-progress: `{"action": "human_checkpoint", "max_stalled_iterations": 2, "signals": ["the same blocking issue repeats without new evidence", "a delivery revision contains no material source or test change", "deterministic verifier output is unchanged after a claimed fix"]}`
- Human checkpoints: `the same blocker repeats twice, a required decision would expand scope beyond SPEC.md or this goal, a step requires publishing, pushing, deployment, destructive cleanup, or provider writes, a reviewer needs a redacted secret-bearing path`
- Stop conditions:
  - every milestone delivery gate and the final conformance gate pass
  - max_iterations or a gate revision cap is reached
  - the no-progress threshold is reached pending user direction
  - the wall-clock or advisory token budget is reached
  - the user requests a stop

## Execution Boundary

- Mode: `in_session`
- Isolation: `current_workspace`
- Side effects: `{"allowed_writes": ["../src/**", "../tests/**", "../docs/**", "../examples/**", "../README.md", "../SPEC.md", "../package.json", "../package-lock.json", "../tsconfig*.json", "../.ensemble/**", "./production-loop-workspace/**"], "commits": "explicitly_authorized", "duplicate_action_check": true, "excluded_work": ["Docker workers", "Windows Service integration", "mutable dashboard UI", "automatic source-control delivery", "publishing to registries or creating hosted releases without separate approval"], "pushes_prs_deployments": "forbidden_without_explicit_user_approval", "requires_approval": false}`

If the loop needs scheduled runs, child-agent lifecycle management, concurrency control, or restart-safe step retries, stop and tell the user this Looper spec should be handed to a durable orchestrator.

## Observability

- State file: `state.json`
- Run log: `run-log.md`
- Checkpoint granularity: `gate`

Use `state.json` for the latest resumable status and `run-log.md` for the append-only history of what happened.

## Privacy

- Before sending `SPEC and public documentation, milestone plans, source and tests, delivery reports, verification output` to `independent-judge`, confirm consent and apply redactions `.env, .env.*, .npmrc, .codex/**, .git/**, node_modules/**, dist/**, *.tgz, secrets/**, **/*.key, **/*.pem, **/*.p12`.

## Start Now

If the user asked to run now, begin at step 1 under Operator Instructions and keep going until a stop condition is reached.
