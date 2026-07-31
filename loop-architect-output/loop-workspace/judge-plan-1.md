# Plan judge 1 — spec-judge

## Verdict

`revise` (confidence 0.96)

## Blocking issues

1. Define retry counting precisely and independently per role.
2. Durable active execution recovery must bypass status and retry policy.
3. Candidate discovery must avoid allocating completed or irrelevant tasks.
4. Allocation ownership and cleanup must cover every pre-runtime failure path.

The judge otherwise found the plan traced the assessed gaps and preserved the
provider, workspace, and Codex boundaries.
