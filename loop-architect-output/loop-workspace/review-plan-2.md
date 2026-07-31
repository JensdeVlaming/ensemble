# Plan review 2 — architecture-reviewer

## Blocking notes

1. A zero retry cap must not block the first execution of a new runnable task;
   the cap applies only when retrying failed work.

## Non-blocking notes

- Preserve stable provider-ID ordering after candidate discovery.
- Active recovery reuses its durable execution ID but starts a fresh runtime.
- Prefer a name that says the setting counts failures.
