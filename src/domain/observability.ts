export const OPERATIONAL_EVENT_NAMES = Object.freeze([
  "observability.record_suppressed",
  "service.starting", "service.running", "service.signal_received", "service.timer_scheduled", "service.wake_requested",
  "service.shutdown_started", "service.shutdown_completed",
  "webhook.server_started", "webhook.server_stopped", "webhook.request_accepted", "webhook.request_rejected",
  "repository.startup_started", "repository.startup_succeeded", "repository.startup_failed",
  "repository.shutdown_completed", "repository.shutdown_failed",
  "configuration.reload_started", "configuration.reload_installed", "configuration.reload_unchanged",
  "configuration.reload_retained", "configuration.reload_failed",
  "tick.started", "tick.completed", "tick.failed",
  "scheduler.startup_started", "scheduler.startup_completed", "scheduler.startup_failed",
  "scheduler.tick_started", "scheduler.tick_completed", "scheduler.tick_failed",
  "reconciliation.started", "reconciliation.completed", "reconciliation.refresh_unreadable",
  "reconciliation.cancellation_started", "reconciliation.local_settled",
  "reconciliation.durable_settled", "reconciliation.failed",
  "candidate.discovered", "candidate.skipped", "candidate.capacity_rejected", "candidate.eligible",
  "claim.started", "claim.succeeded", "claim.conflict", "claim.failed",
  "dispatch.started", "dispatch.runtime_started", "dispatch.completed", "dispatch.failed",
  "retry.deferred", "retry.suppressed", "retry.scheduled", "lease.renewed", "lease.renewal_failed", "lease.lost",
  "synchronization.started", "synchronization.completed", "synchronization.quarantined",
  "synchronization.retry_started", "synchronization.retry_completed", "synchronization.conflict",
  "synchronization.failed", "scheduler.shutdown_started", "scheduler.shutdown_draining",
  "scheduler.shutdown_cancelling", "scheduler.shutdown_completed",
  "configuration.resolve_started", "configuration.resolve_completed", "configuration.resolve_failed",
  "workspace.restore_started", "workspace.restored", "workspace.create_started", "workspace.created",
  "workspace.allocation_failed", "workspace.cleanup_started", "workspace.cleanup_completed",
  "workspace.cleanup_failed", "workspace.hook_started", "workspace.hook_completed", "workspace.hook_failed",
  "runtime.prepare_started", "runtime.prepared", "runtime.start_started",
  "runtime.started", "runtime.event", "runtime.completed", "runtime.blocked", "runtime.failed",
  "runtime.cancellation_started", "runtime.cancellation_completed",
  "provider.rate_limited", "provider.request_retry",
] as const);

export type OperationalEventName = typeof OPERATIONAL_EVENT_NAMES[number];
export type OperationalLogLevel = "debug" | "info" | "warn" | "error";
export type OperationalErrorCategory = "configuration" | "provider" | "claim_conflict" | "runtime"
  | "cancelled" | "timeout" | "stalled" | "synchronization" | "cleanup" | "unexpected";
export type OperationalDataValue = null | boolean | number | string
  | readonly OperationalDataValue[] | { readonly [key: string]: OperationalDataValue };

export interface OperationalEvent {
  readonly level: OperationalLogLevel;
  readonly event: OperationalEventName;
  readonly provider?: string;
  readonly repositoryId?: string;
  readonly taskId?: string;
  readonly role?: string;
  readonly executionId?: string;
  readonly data?: Readonly<Record<string, OperationalDataValue>>;
}

export interface OperationalLogRecord extends OperationalEvent {
  readonly timestamp: string;
  readonly serviceInstanceId: string;
}

export interface OperationalEventReporter {
  emit(event: OperationalEvent): void | Promise<void>;
}

export interface OperationalLogSink {
  write(record: OperationalLogRecord): void | Promise<void>;
}
