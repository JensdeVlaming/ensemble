# Delivery review 1 — architecture-reviewer

## Blocking notes

1. An early event failure can win `Promise.all` and mask a runtime-result error.
2. The read-only reviewer sandbox could not create test temp directories; this
   was an environment limitation, not a product failure. The configured
   writable programmatic gate separately passed 26/26.

## Non-blocking notes accepted for iteration 3

- Add explicit restart-before-retry and stronger provider-state/single-use tests.
- Make repository Codex runtime configuration effective.
- Avoid retaining successful Codex runtime sessions indefinitely.
- Exercise candidate filtering directly in the reference adapter.
