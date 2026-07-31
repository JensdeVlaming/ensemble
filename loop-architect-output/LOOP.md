# ensemble-spec-architecture-refactor

Review and refactor Ensemble against SPEC.md with separate architecture review and structured specification-judge gates.

## Goal

Review and refactor Ensemble's implementation to conform to ../SPEC.md. Produce an architecture assessment, an approved implementation plan, focused code changes, tests, and a final compliance report. Preserve provider, runtime, repository, and workspace replaceability. Exclude production provider adapters, deployment infrastructure, UI, and features not required by the specification.

## Definition of Done

loop-workspace/architecture-assessment.md maps every material SPEC.md requirement to current evidence or a concrete gap; loop-workspace/plan.md contains an architecture-judge-approved implementation plan; the required in-scope refactor and focused tests are implemented in the Ensemble repository; npm test and npm run check pass; and loop-workspace/compliance-report.md provides requirement-by-requirement evidence with no unresolved in-scope blockers or TBDs.

## Verification

- `unit-and-integration-tests` (programmatic)
- `strict-typescript` (programmatic)
- `required-artifacts` (programmatic)
- `plan-spec-traceability` (judge)
- `plan-boundary-safety` (judge)
- `delivery-spec-compliance` (judge)
- `delivery-change-traceability` (judge)
- `delivery-test-quality` (judge)

## Council

- `architecture-reviewer`: reviewer via codex (default)
- `spec-judge`: judge via codex (default)

## Gates

- Plan gate: revise_until_clean
- Delivery gate: revise_until_clean

## Loop Control

- Max iterations: 8
- Budget: `{"tokens": 800000, "wall_clock_min": 90}`
- No-progress: `{"action": "human_checkpoint", "max_stalled_iterations": 2, "signals": ["the same blocking issue repeats without new evidence", "source and test behavior have no material change", "verifier output and compliance evidence are unchanged"]}`

## Execution Boundary

- Mode: `in_session`
- Isolation: `current_workspace`
- Side effects: `{"allowed_writes": ["../src/**", "../tests/**", "../README.md", "../package.json", "../package-lock.json", "../tsconfig.json", "../.ensemble/**", "./loop-workspace/**"], "commits_pushes_prs_deployments": "forbidden_without_explicit_user_approval", "duplicate_action_check": true, "excluded_work": ["production provider adapters", "deployment infrastructure", "UI", "unrelated features"], "requires_approval": true}`

## Observability

- State file: `state.json`
- Run log: `run-log.md`
- Checkpoint granularity: `gate`

## Flow Preview

```text
+--------------------------------+
| 1. Goal + context              |
| read sources                   |
+--------------------------------+
               |
               v
+--------------------------------+
| 2. Draft plan.md               |
| state -> state.json            |
+--------------------------------+
               |
               v
+--------------------------------+
| 3. Plan gate                   |
| verdict: spec-judge            |
+--------------------------------+
               | needs work -> revise <= 3 -> step 2
               | pass
               v
+--------------------------------+
| 4. Write delivery-N.md         |
| log -> run-log.md              |
+--------------------------------+
               |
               v
+--------------------------------+
| 5. Delivery gate               |
| verdict: spec-judge            |
+--------------------------------+
               | needs work -> revise <= 4 -> step 4
               | pass
               v
+--------------------------------+
| 6. Final output                |
| all gates clean                |
+--------------------------------+

Stops: pass gates | max 8 iterations | no progress x2 | budget 90m, 800000 tokens
```
