# Ensemble architecture refactor loop

This directory contains a portable, review-gated loop for assessing and
refactoring Ensemble against [`../SPEC.md`](../SPEC.md).

The default execution path is the current Codex session using
`RUN_IN_SESSION.md`. The external Python runner is available for an explicitly
approved advanced run.

## Artifacts

- `loop.yaml`: human-editable source design
- `loop.resolved.json`: validated compiled specification
- `LOOP.md`: rendered design summary
- `RUN_IN_SESSION.md`: recommended execution handoff
- `run-loop.py`: portable external runner
- `loop-workspace/`: resumable state, assessments, plans, reviews, and reports

## Validate or recompile

```sh
python3 /Users/jensdevlaming/.agents/skills/loop-architect/scripts/looper.py compile \
  loop.yaml \
  --out loop.resolved.json \
  --render LOOP.md \
  --session-prompt RUN_IN_SESSION.md
```

Do not place credentials in this directory. Both non-local council members
require consent before their first send, and configured redaction globs apply.

