# ensemble-production-readiness

Complete Ensemble's remaining specification work through dependency-ordered, independently judged implementation milestones.

## Goal

Bring Ensemble from its current usable Vikunja and Codex CLI service to the production-ready state required by SPEC.md: portable runtime tools and operational events, Codex App Server support, resumable blocked work, credential-safe Vikunja-native tools, complete workspace lifecycle and containment, immutable operational snapshots and read-only endpoints, accurate operator documentation and backlog state, deployable release artifacts, and conformance evidence. Implement and commit coherent dependency-ordered milestones without weakening provider/runtime boundaries, durable provider truth, secret isolation, or cross-platform behavior.

## Definition of Done

Every in-scope MUST requirement in SPEC.md has implementation and focused deterministic test evidence; Codex CLI remains an optional fallback while App Server supports continuation, tools, approvals, input, usage, and rate events; blocked work round-trips durably through ProviderAdapter; Vikunja tools execute on the host without credential egress; workspace hooks, restore verification, refresh, containment, and cleanup are bounded and safe; immutable snapshots and configured read-only health/status endpoints expose no secrets; npm test, npm run check, npm run build, npm pack --dry-run, git diff --check, artifact credential scans, and the v0.3 conformance suite pass; Linux and macOS service artifacts are verified, with any real-host or publication step that cannot be performed locally documented as an external acceptance item; each milestone is independently judged and committed.

## Verification

- `tests` (programmatic)
- `types` (programmatic)
- `build` (programmatic)
- `diff-integrity` (programmatic)
- `milestone-traceability` (judge)
- `architecture-and-security` (judge)
- `test-quality` (judge)

## Council

- `independent-judge`: judge via codex-subagent (gpt-5.6-sol)

## Gates

- Plan gate: revise_until_clean
- Delivery gate: revise_until_clean

## Loop Control

- Max iterations: 16
- Budget: `{"tokens": 2000000, "wall_clock_min": 480}`
- No-progress: `{"action": "human_checkpoint", "max_stalled_iterations": 2, "signals": ["the same blocking issue repeats without new evidence", "a delivery revision contains no material source or test change", "deterministic verifier output is unchanged after a claimed fix"]}`

## Execution Boundary

- Mode: `in_session`
- Isolation: `current_workspace`
- Side effects: `{"allowed_writes": ["../src/**", "../tests/**", "../docs/**", "../examples/**", "../README.md", "../SPEC.md", "../package.json", "../package-lock.json", "../tsconfig*.json", "../.ensemble/**", "./production-loop-workspace/**"], "commits": "explicitly_authorized", "duplicate_action_check": true, "excluded_work": ["Docker workers", "Windows Service integration", "mutable dashboard UI", "automatic source-control delivery", "publishing to registries or creating hosted releases without separate approval"], "pushes_prs_deployments": "forbidden_without_explicit_user_approval", "requires_approval": false}`

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
| verdict: independent-judge     |
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
| verdict: independent-judge     |
+--------------------------------+
               | needs work -> revise <= 3 -> step 4
               | pass
               v
+--------------------------------+
| 6. Final output                |
| all gates clean                |
+--------------------------------+

Stops: pass gates | max 16 iterations | no progress x2 | budget 480m, 2000000 tokens
```
