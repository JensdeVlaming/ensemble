# Milestone 5 delivery — repository refresh and bounded workspace hooks

## Delivered

- `GitRepositoryDriver.refresh` verifies the exact configured origin and branch,
  fetches through argv-only bounded commands, fast-forwards only a clean checkout
  that is strictly behind upstream, and otherwise preserves dirty files, local
  commits, and divergent restart work.
- Restored workspaces validate their pinned identity, refresh the repository,
  then revalidate every component and the immutable manifest before returning.
- Git processes use a narrow environment, exclude provider credentials, disable
  interactive prompts, bound combined output, enforce a deadline, and return
  fixed errors without child output.
- Added an injectable workspace hook runner. Hooks use exact executable/argv,
  repository cwd, a documented minimal environment, bounded discarded output,
  timeout plus termination, and fixed redacted failures.
- ExecutionEngine runs `afterCreate` once for new workspaces, `beforeRun` after
  final workspace validation and before runtime preparation, `afterRun` once for
  every started attempt, and `beforeRemove` only when the workspace manager will
  actually remove a workspace.
- `afterCreate` and `beforeRun` failures remain primary. `afterRun` and
  `beforeRemove` failures are observable but secondary; cleanup and the original
  runtime/block/cancellation result retain precedence.

## Verification

- Focused Git tests cover origin/branch mismatch, clean fast-forward, dirty and
  local-commit preservation, refresh-on-restore, minimal environment, output
  limit, timeout, and secret-safe errors.
- Focused hook tests cover exact order, argv/cwd/environment, every failure
  semantic, output bounds, timeout, cleanup continuation, and primary-error
  precedence.
- `npm test`: 194 passed, 0 failed.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Scope boundary

Terminal/startup workspace inventory and forced terminal removal remain
milestone 6. Hook output is deliberately not emitted; structured lifecycle
events expose only hook identity and result category.
