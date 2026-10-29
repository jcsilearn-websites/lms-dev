import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

// SQL only. A tenant job is a plain INSERT through the caller's tenant transaction (RLS: its own
// tenant only). Everything the WORKER does (it has no tenant context) is a hardened SECURITY DEFINER
// function (migration 0010): one function call = one statement = one round trip.

export interface EnqueueInput {
  id: string;
  queue: string;
  payload: unknown;
  /** null = start now */
  runAt: Date | null;
  maxAttempts: number;
  singletonKey: string | null;
}

export interface ClaimedJob {
  id: string;
  queue: string;
  tenantId: string | null;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export type FailOutcome = 'retry' | 'dead' | 'lost';

export function createJobsRepository() {
  return {
    /** Inside the caller's tenant transaction: the job exists exactly when the business write does. */
    async enqueue(tx: Executor, tenantId: string, j: EnqueueInput): Promise<boolean> {
      const res = await tx.execute(
        sql`INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
            VALUES (${j.id}::uuid, ${j.queue}::text, ${tenantId}::uuid, ${JSON.stringify(j.payload)}::jsonb,
                    COALESCE(${j.runAt?.toISOString() ?? null}::timestamptz, now()), ${j.maxAttempts}::int,
                    ${j.singletonKey}::text)
            ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL DO NOTHING`,
      );
      return (res.rowCount ?? 0) > 0;
    },

    async enqueueSystem(exec: Executor, j: EnqueueInput): Promise<boolean> {
      const res = await exec.execute(
        sql`SELECT lms.job_enqueue_system(${j.id}::uuid, ${j.queue}::text, ${JSON.stringify(j.payload)}::jsonb,
              ${j.runAt?.toISOString() ?? null}::timestamptz, ${j.maxAttempts}::int, ${j.singletonKey}::text) AS inserted`,
      );
      return res.rows[0]?.inserted === true;
    },

    async claim(
      exec: Executor,
      queue: string,
      worker: string,
      limit: number,
      leaseSeconds: number,
    ): Promise<ClaimedJob[]> {
      const res = await exec.execute(
        sql`SELECT * FROM lms.job_claim(${queue}::text, ${worker}::text, ${limit}::int, ${leaseSeconds}::int)`,
      );
      return res.rows.map((r) => ({
        id: r.r_id as string,
        queue: r.r_queue as string,
        tenantId: (r.r_tenant_id as string | null) ?? null,
        payload: r.r_payload,
        attempts: Number(r.r_attempts),
        maxAttempts: Number(r.r_max_attempts),
      }));
    },

    async complete(exec: Executor, id: string, worker: string, result: unknown): Promise<boolean> {
      const res = await exec.execute(
        sql`SELECT lms.job_complete(${id}::uuid, ${worker}::text, ${result === undefined ? null : JSON.stringify(result)}::jsonb) AS ok`,
      );
      return res.rows[0]?.ok === true;
    },

    async fail(
      exec: Executor,
      id: string,
      worker: string,
      error: string,
      backoffBaseSeconds: number,
      backoffMaxSeconds: number,
    ): Promise<FailOutcome> {
      const res = await exec.execute(
        sql`SELECT lms.job_fail(${id}::uuid, ${worker}::text, ${error}::text, ${backoffBaseSeconds}::int, ${backoffMaxSeconds}::int) AS outcome`,
      );
      return res.rows[0]?.outcome as FailOutcome;
    },

    async extendLease(
      exec: Executor,
      id: string,
      worker: string,
      leaseSeconds: number,
    ): Promise<boolean> {
      const res = await exec.execute(
        sql`SELECT lms.job_extend_lease(${id}::uuid, ${worker}::text, ${leaseSeconds}::int) AS ok`,
      );
      return res.rows[0]?.ok === true;
    },

    async release(exec: Executor, id: string, worker: string): Promise<boolean> {
      const res = await exec.execute(
        sql`SELECT lms.job_release(${id}::uuid, ${worker}::text) AS ok`,
      );
      return res.rows[0]?.ok === true;
    },

    async purge(
      exec: Executor,
      completedDays: number,
      deadDays: number,
      batch: number,
    ): Promise<number> {
      const res = await exec.execute(
        sql`SELECT lms.job_purge(${completedDays}::int, ${deadDays}::int, ${batch}::int) AS n`,
      );
      return Number(res.rows[0]?.n ?? 0);
    },
  };
}
export type JobsRepository = ReturnType<typeof createJobsRepository>;
