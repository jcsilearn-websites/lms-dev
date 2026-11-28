import { sql } from 'drizzle-orm';
import type { MfaResetItem, MfaResetRequest } from '../../contracts';
import type { Executor } from '../../db/client';

// SQL only (the four-eyes reset of a second factor, step 14c part 2). mfa_reset_requests is not readable by lms_app: every
// function here calls a SECURITY DEFINER function (migration 0072) that re-checks that the actor is a platform administrator.
// One call = one statement = one round trip. Every time decision takes `now` from the caller.

export interface MfaResetOutcome {
  result:
    | 'ok'
    | 'not_found'
    | 'self'
    | 'self_approval'
    | 'not_enrolled'
    | 'in_progress'
    | 'not_pending'
    | 'expired'
    | 'too_late';
  request?: MfaResetRequest;
}

/** timestamptz inside jsonb is text like 2026-01-01T00:00:00+00:00: normalise to the contract's date-time. */
const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

const requestOf = (r: MfaResetRequest): MfaResetRequest => ({
  id: r.id,
  status: r.status,
  requestedAt: iso(r.requestedAt) as string,
  expiresAt: iso(r.expiresAt) as string,
  executeAfter: iso(r.executeAfter),
});

const outcomeOf = (v: MfaResetOutcome): MfaResetOutcome => ({
  result: v.result,
  ...(v.request ? { request: requestOf(v.request) } : {}),
});

export function createMfaResetRepository() {
  return {
    async file(
      db: Executor,
      a: { actor: string; email: string; ip: string | null; now: Date },
    ): Promise<MfaResetOutcome> {
      const res = await db.execute(
        sql`select lms.mfa_reset_request(${a.actor}::uuid, ${a.email}::text, ${a.ip}::inet, ${a.now.toISOString()}::timestamptz) as r`,
      );
      return outcomeOf((res.rows[0] as { r: MfaResetOutcome }).r);
    },

    async decide(
      db: Executor,
      a: {
        actor: string;
        id: string;
        action: 'approve' | 'reject' | 'cancel';
        ip: string | null;
        now: Date;
      },
    ): Promise<MfaResetOutcome> {
      const res = await db.execute(
        sql`select lms.mfa_reset_decide(${a.actor}::uuid, ${a.id}::uuid, ${a.action}::text, ${a.ip}::inet, ${a.now.toISOString()}::timestamptz) as r`,
      );
      return outcomeOf((res.rows[0] as { r: MfaResetOutcome }).r);
    },

    async list(
      db: Executor,
      a: { actor: string; limit: number; after: string | null },
    ): Promise<{ items: MfaResetItem[]; hasMore: boolean }> {
      const res = await db.execute(
        sql`select lms.mfa_reset_list(${a.actor}::uuid, ${a.limit}::int, ${a.after}::uuid) as r`,
      );
      const page = (res.rows[0] as { r: { items: MfaResetItem[]; hasMore: boolean } }).r;
      return {
        hasMore: page.hasMore,
        items: page.items.map((i) => ({
          ...i,
          ...requestOf(i),
          executedAt: iso(i.executedAt),
        })),
      };
    },

    async expire(db: Executor, now: Date, limit: number): Promise<number> {
      const res = await db.execute(
        sql`select lms.mfa_reset_expire(${now.toISOString()}::timestamptz, ${limit}::int) as n`,
      );
      return Number((res.rows[0] as { n: number }).n);
    },

    async due(db: Executor, now: Date, limit: number): Promise<string[]> {
      const res = await db.execute(
        sql`select r_id from lms.mfa_reset_due(${now.toISOString()}::timestamptz, ${limit}::int)`,
      );
      return (res.rows as { r_id: string }[]).map((r) => r.r_id);
    },

    async execute(db: Executor, id: string, now: Date): Promise<string> {
      const res = await db.execute(
        sql`select lms.mfa_reset_execute(${id}::uuid, ${now.toISOString()}::timestamptz) as r`,
      );
      return (res.rows[0] as { r: { result: string } }).r.result;
    },
  };
}
export type MfaResetRepository = ReturnType<typeof createMfaResetRepository>;
