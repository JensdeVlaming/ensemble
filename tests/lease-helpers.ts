import { processExecutionOwner } from "../src/index.ts";
import type { ActiveExecution, ExecutionLeaseClaim, ExecutionLeaseGuard } from "../src/index.ts";

export function leaseClaim(active?: ActiveExecution, ownerId: string = processExecutionOwner.id): ExecutionLeaseClaim {
  return {
    ownerId,
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    expected: !active ? { kind: "none" } : active.ownerId && active.leaseExpiresAt ? {
      kind: "leased", executionId: active.id, role: active.role, startedAt: active.startedAt,
      ownerId: active.ownerId, leaseExpiresAt: active.leaseExpiresAt,
    } : { kind: "legacy", executionId: active.id, role: active.role, startedAt: active.startedAt },
  };
}

export function leaseGuard(active: ActiveExecution): ExecutionLeaseGuard {
  if (!active.ownerId || !active.leaseExpiresAt) throw new Error("Expected a leased execution");
  return { ownerId: active.ownerId, leaseExpiresAt: active.leaseExpiresAt, observedAt: "2026-01-01T00:00:00.000Z" };
}
