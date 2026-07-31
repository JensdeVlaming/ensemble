# Plan review 3 — architecture-reviewer

## Blocking notes

None.

## Non-blocking notes

The reviewer recommended deterministic history tie-breaking, explicit retry
status semantics, candidate ownership in adapters, duplicate-start protection,
capability-scoped environments, explicit lifecycle idempotency, and preserving
primary failures over cleanup failures. These are implementation checks.
