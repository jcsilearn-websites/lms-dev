/**
 * Background-job handlers (run by the worker, see worker.ts). Each module exposes
 * `<module>.handlers.ts`; the handler NAME is the queue name. Handlers call the module's service and
 * never touch the database directly (services own the transactions: a tenant job's handler passes
 * `ctx.tenantId` to its service, which opens `db.withTenant(ctx.tenantId, ...)`).
 * A handler with `everyMs` is also SCHEDULED: every `everyMs` a system job is enqueued on its queue
 * (at most one per time slot across all worker instances).
 */
export type HandlerResult = Record<string, number> | undefined;

/** What the job queue tells a running handler. */
export interface JobContext {
  jobId: string;
  queue: string;
  /** The tenant the job belongs to; null for system jobs. */
  tenantId: string | null;
  /** 1-based attempt number (a retry or a re-claim after a crash is attempt 2, ...). */
  attempt: number;
  maxAttempts: number;
  /**
   * Aborted when the worker is shutting down or the job lost its lease. A long handler checks it
   * between batches and returns: the job is then released (shutdown) or left to its new owner.
   */
  signal: AbortSignal;
}

export type JobHandler<TPayload = unknown> = (
  payload: TPayload,
  ctx: JobContext,
) => Promise<HandlerResult>;

export interface Handler {
  run: JobHandler;
  /** Also enqueue this queue on a schedule: one system job per `everyMs` slot. */
  everyMs?: number;
}
export type HandlerMap = Record<string, Handler>;
