# Ensemble production-readiness loop

This directory contains the Loop Architect definition for completing Ensemble's
remaining production-readiness work against `../SPEC.md`.

The editable source is `loop.yaml`; `loop.resolved.json`, `LOOP.md`, and
`RUN_IN_SESSION.md` are generated from it. The optional `run-loop.py` runner is
kept portable. New plans, delivery evidence, judge verdicts, state, and logs are
written under `production-loop-workspace/`. The earlier `loop-workspace/`
directory remains as historical evidence from the completed architecture loop.

The current session executes the loop and uses an isolated read-only Codex
subagent as the independent judge. Secret-bearing files, generated packages,
Git metadata, dependencies, and local Codex state are excluded from review.

Commits are explicitly authorized. Pushes, pull requests, deployments,
provider writes, registry publication, and hosted release creation are not.
