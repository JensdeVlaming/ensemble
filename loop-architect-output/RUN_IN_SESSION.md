# Run `ensemble-spec-architecture-refactor` In This Session

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
- Workspace: `./loop-workspace`
- State file: `state.json`
- Run log: `run-log.md`

## Goal

Review and refactor Ensemble's implementation to conform to ../SPEC.md. Produce an architecture assessment, an approved implementation plan, focused code changes, tests, and a final compliance report. Preserve provider, runtime, repository, and workspace replaceability. Exclude production provider adapters, deployment infrastructure, UI, and features not required by the specification.

## Definition Of Done

loop-workspace/architecture-assessment.md maps every material SPEC.md requirement to current evidence or a concrete gap; loop-workspace/plan.md contains an architecture-judge-approved implementation plan; the required in-scope refactor and focused tests are implemented in the Ensemble repository; npm test and npm run check pass; and loop-workspace/compliance-report.md provides requirement-by-requirement evidence with no unresolved in-scope blockers or TBDs.

## Context Sources

- Read file `../SPEC.md`
- Read file `../AGENTS.md`
- Read file `../README.md`
- Read file `../package.json`
- Read file `../tsconfig.json`
- Run command `["rg", "-n", ".", "../src", "../tests"]`

## Verification Criteria

- `unit-and-integration-tests` programmatic: run `["npm", "--prefix", "..", "test"]` and expect `exit_zero`
- `strict-typescript` programmatic: run `["npm", "--prefix", "..", "run", "check"]` and expect `exit_zero`
- `required-artifacts` programmatic: run `["python3", "-c", "from pathlib import Path; paths = [Path('loop-workspace/architecture-assessment.md'), Path('loop-workspace/plan.md'), Path('loop-workspace/compliance-report.md')]; raise SystemExit(0 if all(path.is_file() and path.stat().st_size > 0 for path in paths) else 1)"]` and expect `exit_zero`
- `plan-spec-traceability` judge rubric: Inspect loop-workspace/architecture-assessment.md and plan.md. Every material requirement in SPEC.md must map to concrete current evidence, a specific implementation change, or an explicit out-of-scope reason consistent with the goal. The plan must identify affected boundaries, tests, failure/recovery behavior, migration risk, and an objective done state. Missing requirements, vague actions, or unsupported compliance claims are blocking issues.

- `plan-boundary-safety` judge rubric: The plan must keep provider-specific behavior behind ProviderAdapter, runtime-specific behavior behind Runtime, workspace/repository lifecycle inside the execution boundary, and durable workflow state in the task provider. It must not add production provider adapters, deployment infrastructure, UI, hidden durable orchestrator state, or unrelated features. Any proposed coupling or scope expansion is blocking.

- `delivery-spec-compliance` judge rubric: Inspect SPEC.md, loop-workspace/context.md as the pre-change baseline, the current ../src and ../tests trees, the approved plan, and loop-workspace/compliance-report.md. The implementation must satisfy the material specification invariants: deterministic scheduling, provider-owned recoverable workflow state, runtime/provider independence, execution-engine-owned workspace lifecycle, common structured runtime events/results, repository-defined execution, and Codex encapsulation. Every compliance claim must cite observable code or test evidence. Any material mismatch or unsupported claim is blocking.

- `delivery-change-traceability` judge rubric: At least one material implementation or test improvement must exist relative to loop-workspace/context.md. Every changed behavior must trace to an assessment finding and approved plan item. Reject unrelated rewrites, excluded features, duplicated provider state, runtime leakage, or changes made only to satisfy superficial checks.

- `delivery-test-quality` judge rubric: Tests must cover each changed architectural behavior and its meaningful failure or restart path where applicable. Passing commands alone are not sufficient if their assertions do not exercise the claimed invariant. Flaky, network-dependent, or implementation-trivial tests are blocking.


## Council

- `architecture-reviewer` reviewer via `["codex", "exec", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "read-only", "--add-dir", ".."]` (non-local; timeout 900s)
- `spec-judge` judge via `["codex", "exec", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "read-only", "--add-dir", ".."]` (non-local; timeout 900s)

## Gates

### plan_gate

- When: `after_plan`
- Policy: `revise_until_clean`
- Verdict source: `spec-judge`
- Criteria: `plan-spec-traceability, plan-boundary-safety`
- Max revisions: `3`

### delivery_gate

- When: `after_each_delivery`
- Policy: `revise_until_clean`
- Verdict source: `spec-judge`
- Criteria: `unit-and-integration-tests, strict-typescript, required-artifacts, delivery-spec-compliance, delivery-change-traceability, delivery-test-quality`
- Max revisions: `4`

## Loop Control

- Max iterations: `8`
- Budget: `{"tokens": 800000, "wall_clock_min": 90}`
- No-progress: `{"action": "human_checkpoint", "max_stalled_iterations": 2, "signals": ["the same blocking issue repeats without new evidence", "source and test behavior have no material change", "verifier output and compliance evidence are unchanged"]}`
- Human checkpoints: `repeated no-progress or the same blocker twice, any proposed scope expansion beyond SPEC.md, any external side effect such as commit, push, PR, deployment, or message, any need to read or transmit a redacted path`
- Stop conditions:
  - plan and delivery gates both pass clean
  - max_iterations or a gate revision cap is reached
  - no-progress threshold is reached pending human direction
  - wall-clock or advisory token budget is reached
  - the user requests a stop

## Execution Boundary

- Mode: `in_session`
- Isolation: `current_workspace`
- Side effects: `{"allowed_writes": ["../src/**", "../tests/**", "../README.md", "../package.json", "../package-lock.json", "../tsconfig.json", "../.ensemble/**", "./loop-workspace/**"], "commits_pushes_prs_deployments": "forbidden_without_explicit_user_approval", "duplicate_action_check": true, "excluded_work": ["production provider adapters", "deployment infrastructure", "UI", "unrelated features"], "requires_approval": true}`

If the loop needs scheduled runs, child-agent lifecycle management, concurrency control, or restart-safe step retries, stop and tell the user this Looper spec should be handed to a durable orchestrator.

## Observability

- State file: `state.json`
- Run log: `run-log.md`
- Checkpoint granularity: `gate`

Use `state.json` for the latest resumable status and `run-log.md` for the append-only history of what happened.

## Privacy

- Before sending `architecture assessment, implementation plan, source and tests on demand, delivery artifacts, compliance report` to `architecture-reviewer`, confirm consent and apply redactions `.env, .env.*, .npmrc, .codex/**, .git/**, node_modules/**, secrets/**, **/*.key, **/*.pem, **/*.p12`.
- Before sending `architecture assessment, implementation plan, source and tests on demand, delivery artifacts, compliance report, verification results` to `spec-judge`, confirm consent and apply redactions `.env, .env.*, .npmrc, .codex/**, .git/**, node_modules/**, secrets/**, **/*.key, **/*.pem, **/*.p12`.

## Start Now

If the user asked to run now, begin at step 1 under Operator Instructions and keep going until a stop condition is reached.
