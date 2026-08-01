# Milestone 2 delivery — Codex App Server production transport

## Delivered

- Added an argv-based, explicit-environment Codex App Server process boundary
  using the documented stdio JSONL protocol.
- Implemented initialize/initialized, thread/start, turn/start, turn/completed,
  turn/interrupt, request/response correlation, fragmented JSONL framing,
  bounded message/request queues, request deadlines, process-exit settlement,
  and idempotent cancellation.
- Kept thread IDs, turn IDs, and durable provider execution IDs separate and
  validated at their respective boundaries.
- Codex Runtime now owns bounded corrective continuation turns on one live
  thread. Invalid structured results trigger a corrective turn; exhaustion is
  a typed runtime failure visible to Scheduler without exposing Codex protocol
  types outside the runtime package.
- Added server-request handling for command, file-change, permission, user-input,
  and MCP elicitation requests. Runtime policy supports block, reject, and a
  narrow command/file automatic allowlist.
- Registered experimental dynamic tools using only captured portable tool
  definitions. Calls require an exact captured name and go through the validated
  host invocation closure with bounded portable output.
- Projected command/file/dynamic item lifecycle, token usage, and multi-bucket
  rate limits into portable Runtime events using the generated official wire
  shapes. Agent/reasoning/command/file deltas emit payload-free heartbeats so
  active turns cannot be misclassified as stalled.
- Successful turns remain resumable on the same live thread during a bounded
  idle window and share one non-resetting max-turn budget across corrective and
  explicit continuation turns.
- Added strict `codex-app-server` host registration while retaining `codex-cli`
  as an independent optional fallback.

## Verification

- Focused App Server tests cover fragmented framing, handshake, thread/turn
  correlation, continuation, exhaustion, resume, interrupt/cancel, every blocked
  request family, reject/automatic policy, dynamic tools, usage/rate events,
  malformed input, early exit, correlation failure, and request timeout.
- `npm test`: 172 passed, 0 failed.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Scope boundary

Provider-native tool registration remains milestone 3. App Server consumes the
portable capabilities established in milestone 1 but does not know provider
types or credentials.
