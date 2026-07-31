# Plan review 1 — architecture-reviewer

## Blocking notes

1. Retry semantics are underspecified. Define whether `maxAttempts` means total
   attempts or retries, and whether failures count globally, consecutively, or
   per role. Earlier-role failures must not accidentally exhaust later roles.
2. Durable active-execution recovery must bypass ordinary status and retry
   eligibility or restart reconstruction can strand active work.
3. Allocation ownership is incomplete: define release when Scheduler declines a
   task or fails before runtime invocation, unknown/reused handles, and
   configuration-load failure.
4. Discovering all provider tasks and allocating a workspace merely to read
   repository policy can repeatedly clone completed/irrelevant repositories.
   Define a deterministic provider-independent candidate strategy that avoids
   unbounded churn.

## Non-blocking notes

- Trace SPEC section 9 explicitly: Runtime owns context/prompt construction;
  Scheduler gathers provider data; Engine transports complete RuntimeContext.
- Validate and return immutable provider execution history at the adapter edge.
- Test unusual status active recovery, cleanup after scheduler rejection, and
  retry counting across roles.
- Decide whether legacy `recordExecution` remains; dual atomic/granular paths
  can diverge.
- Compliance must distinguish implemented CLI support from a documented blocker.
