# Milestone 3 delivery — credential-safe Vikunja-native tools

## Delivered

- Extended `ProviderAdapter` with task- and execution-scoped runtime tool
  discovery. Scheduler obtains tools only after the durable claim and captures
  them with comments and artifacts in the execution request.
- Added four Vikunja capabilities: `task_read`, `task_comments_read`,
  `task_artifacts_read`, and `task_comment_add` using App Server-safe names.
- Every invocation rechecks that the captured provider execution remains active.
  A capability cannot read or mutate a different task and stops working after
  terminal synchronization.
- Tool input passes the portable schema validator before invocation. Comment
  bodies and idempotency keys receive additional provider-side bounds before a
  network write.
- Comment writes use an execution-scoped hidden marker. Same-process concurrent
  retries are serialized, overlapping provider instances reconcile duplicate
  markers to the lowest durable comment, and provider reconstruction recognizes
  the marker. Retries after restart return the original comment without another
  durable result. Reusing a key with a different body fails closed.
- Results contain selected portable fields only, cap array, UTF-8 string, and
  aggregate serialized sizes, omit provider metadata and artifact metadata, and
  return fixed error messages rather than raw API failures.
- Provider credentials remain captured by the Vikunja client closure. They do
  not enter definitions, inputs, results, runtime environments, prompts,
  workspaces, logs, or runtime snapshots. Existing environment, logging,
  prompt-serialization, and packaging boundaries continue to enforce those
  exclusions.

## Verification

- Focused scheduler coverage proves discovery occurs after claim and capabilities
  reach the execution environment.
- Focused Vikunja coverage proves claim scope, output bounds, metadata and token
  exclusion, validation before writes, concurrent/restart idempotency, conflict
  rejection, aggregate budgets, redacted provider failures, marker hiding, and
  revocation after completion or lease takeover.
- `npm test`: 176 passed, 0 failed.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Scope boundary

The tools intentionally expose only the currently claimed Vikunja task. Broader
provider search, status mutation, attachment upload, and source-control delivery
remain outside this milestone.
