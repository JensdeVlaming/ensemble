# Milestone 4 delivery — collision-safe workspace identity and containment

## Delivered

- Workspace names now combine a bounded readable task prefix with a stable
  SHA-256-derived suffix over the provider/repository namespace and exact opaque
  task ID. Host composition supplies `provider:registration` namespaces.
- New workspaces receive an atomic mode-`0600` identity manifest with exact
  schema version, namespace, task ID, and repository identity. Restoration
  rejects missing, oversized, malformed, over-permissive, foreign-owned,
  symlinked, or identity-mismatched manifests.
- Creation, restoration, explicit validation, runtime preparation, migration,
  quarantine, cleanup, and removal recheck normalized/root-contained,
  non-symlink boundaries, safe base ownership/modes, and pinned device/inode
  identities for the root, repository, and runtime directories. ExecutionEngine
  revalidates the originally allocated manifest and filesystem identities
  immediately before runtime preparation.
- Legacy directories are never restored directly. The manager enumerates them
  through random opaque handles and classifies exact caller-supplied task
  identities as unique, ambiguous, or unmatched without exposing a path or
  historical naming function.
- Unique matches can be atomically renamed to the namespaced path and receive a
  validated manifest before use. Ambiguous/unmatched entries can be quarantined
  or removed through single-use opaque capabilities.
- Repository and runtime directory replacement is rejected before validation or
  deletion, and recursive removal never targets the configured root or follows
  a replaced symlink.

## Verification

- Focused tests cover normalized-ID collision, namespace separation, manifest
  content/mode/tampering/size/symlink failures, repository symlink replacement,
  opaque legacy classification, ambiguity, migration, quarantine, single-use
  handles, and immediate Engine validation.
- `npm test`: 183 passed, 0 failed.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Scope boundary

Scheduler-owned provider inventory and terminal cleanup orchestration remain
milestone 6. Repository refresh and lifecycle hooks remain milestone 5.
