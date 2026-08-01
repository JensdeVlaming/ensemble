# Milestone 6 delivery — Scheduler-owned terminal and startup cleanup

## Delivered

- Added a portable provider inventory contract that distinguishes complete from
  partial reads and current from terminal/native-archived work.
- Vikunja now produces a bounded, paginated inventory across visible projects,
  including completed and archived tasks. The in-memory reference provider
  implements the same contract.
- ExecutionEngine exposes opaque legacy and managed workspace classifications;
  Scheduler never receives filesystem paths or provider metadata.
- Startup and ticks migrate uniquely matched current legacy workspaces, remove
  matched terminal work, remove authoritatively missing work only after a
  complete inventory, and quarantine ambiguous, invalid, or partial-inventory
  matches.
- Managed workspaces with damaged/missing manifests are distinguished from
  historical legacy names and quarantined. Removal revalidates pinned
  filesystem identities and remains restart-idempotent.
- Terminal completion requests forced removal only after provider completion is
  durable. Active reconciliation retains the workspace until local execution
  and synchronization ownership have settled.
- Terminal removal waits for attempt cleanup, preserving `afterRun` before
  `beforeRemove`; ordinary hook failure stays secondary while unconfirmed
  process termination still blocks destructive transitions.

## Verification

- Tests cover startup-before-configuration ordering, complete and partial
  inventories, unique migration, terminal and missing deletion policy,
  ambiguous/invalid quarantine, hook failure, archived Vikunja tasks,
  restart-idempotency, terminal synchronization, and lifecycle ordering.
- `npm test`: 202 passed, 0 failed.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Scope boundary

Immutable runtime snapshots and read-only health endpoints remain milestone 7.
Documentation, v0.3 conformance, release verification, and external acceptance
remain milestone 8.
