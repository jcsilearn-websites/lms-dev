import { newId } from '../../core/uuid';
import type { Database, Executor } from '../../db/client';
import type { ClaimedJob, FailOutcome, JobsRepository } from './jobs.repository';

export interface JobsConfig {
  /** Poll interval of a queue that is busy, and the first step of the idle back-off. */
  pollIntervalMs: number;
  /** The idle back-off never waits longer than this (JOB_POLL_MAX_INTERVAL_MS). */
  pollMaxIntervalMs: number;
  /** A running job must renew its lease at least this often or another worker takes it over. */
  leaseSeconds: number;
  maxAttempts: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  /** On shutdown, in-flight jobs get this long to finish; the rest is released. */
  shutdownGraceSeconds: number;
  /** Queue name -> max jobs running at once on one worker; `default` covers the others. */
  concurrency: Record<string, number>;
  completedRetentionDays: number;
  deadRetentionDays: number;
  /** Rows per purge statement (bounded so the purge never holds locks for long). */
  purgeBatchSize: number;
}

export interface EnqueueOptions {
  queue: string;
  /** null = system job. Otherwise the tenant the handler runs as. */
  tenantId: string | null;
  payload?: unknown;
  runAt?: Date;
  maxAttempts?: number;
  /** At most one job with this key, ever (until purged). */
  singletonKey?: string;
}

export const DEFAULT_JOBS_CONFIG: JobsConfig = {
  pollIntervalMs: 1000,
  pollMaxIntervalMs: 10_000,
  leaseSeconds: 60,
  maxAttempts: 5,
  backoffBaseSeconds: 10,
  backoffMaxSeconds: 3600,
  shutdownGraceSeconds: 8,
  concurrency: { default: 2 },
  completedRetentionDays: 7,
  deadRetentionDays: 30,
  purgeBatchSize: 1000,
};

const MAX_PURGE_BATCHES = 100;

export function createJobsService(deps: {
  db: Pick<Database, 'withoutTenant'>;
  jobsRepo: JobsRepository;
  config?: Partial<JobsConfig>;
  now?: () => number;
}) {
  const { db, jobsRepo } = deps;
  const config: JobsConfig = { ...DEFAULT_JOBS_CONFIG, ...deps.config };
  const now = deps.now ?? Date.now;
  const listeners = new Set<(queue: string) => void>();

  async function enqueue(exec: Executor, o: EnqueueOptions): Promise<boolean> {
    const job = {
      id: newId(),
      queue: o.queue,
      payload: o.payload ?? {},
      runAt: o.runAt ?? null,
      maxAttempts: o.maxAttempts ?? config.maxAttempts,
      singletonKey: o.singletonKey ?? null,
    };
    const inserted =
      o.tenantId === null
        ? await jobsRepo.enqueueSystem(exec, job)
        : await jobsRepo.enqueue(exec, o.tenantId, job);
    if (inserted) for (const l of listeners) l(o.queue);
    return inserted;
  }

  return {
    config,

    /**
     * Enqueues a job through `exec`. For a tenant job pass the transaction of the business write
     * (`db.withTenant(tenantId, (tx) => { ...write...; jobs.enqueue(tx, {...}) })`): if the write
     * rolls back, the job never existed. In-process pollers are woken (their next poll is immediate,
     * so the job is picked up as soon as the transaction has committed).
     */
    enqueue,

    /**
     * Tells in-process pollers a job was enqueued on `queue` (for code that inserts job rows itself,
     * in a set-based statement, instead of calling enqueue()). Call it AFTER the transaction committed.
     */
    notifyEnqueued(queue: string): void {
      for (const l of listeners) l(queue);
    },

    /** Subscribe to "a job was enqueued in this process" (the runner resets its poll back-off). */
    onEnqueue(listener: (queue: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The scheduler's tick: one system job per `everyMs` time slot, however many worker instances
     * tick (the singleton key is "<name>:<slot>").
     */
    async schedule(name: string, everyMs: number): Promise<boolean> {
      const slot = Math.floor(now() / everyMs);
      return db.withoutTenant((exec) =>
        enqueue(exec, {
          queue: name,
          tenantId: null,
          maxAttempts: 3,
          singletonKey: `${name}:${slot}`,
        }),
      );
    },

    claim(queue: string, worker: string, limit: number): Promise<ClaimedJob[]> {
      return db.withoutTenant((exec) =>
        jobsRepo.claim(exec, queue, worker, limit, config.leaseSeconds),
      );
    },
    complete(id: string, worker: string, result: unknown): Promise<boolean> {
      return db.withoutTenant((exec) => jobsRepo.complete(exec, id, worker, result));
    },
    fail(id: string, worker: string, error: string): Promise<FailOutcome> {
      return db.withoutTenant((exec) =>
        jobsRepo.fail(exec, id, worker, error, config.backoffBaseSeconds, config.backoffMaxSeconds),
      );
    },
    extendLease(id: string, worker: string): Promise<boolean> {
      return db.withoutTenant((exec) =>
        jobsRepo.extendLease(exec, id, worker, config.leaseSeconds),
      );
    },
    release(id: string, worker: string): Promise<boolean> {
      return db.withoutTenant((exec) => jobsRepo.release(exec, id, worker));
    },

    /**
     * Retention: completed jobs after `completedRetentionDays`, dead ones after `deadRetentionDays`,
     * at most `purgeBatchSize` rows per statement, looping until a short batch (never more than 100
     * batches per run).
     */
    async purgeFinished(): Promise<number> {
      let total = 0;
      for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
        const n = await db.withoutTenant((exec) =>
          jobsRepo.purge(
            exec,
            config.completedRetentionDays,
            config.deadRetentionDays,
            config.purgeBatchSize,
          ),
        );
        total += n;
        if (n < config.purgeBatchSize) break;
      }
      return total;
    },
  };
}
export type JobsService = ReturnType<typeof createJobsService>;
