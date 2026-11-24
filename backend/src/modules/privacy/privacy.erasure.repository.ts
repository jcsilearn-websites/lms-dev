import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

// SQL only. Every change is a definer function (migrations 0063 / 0064); the app role reads the request rows and nothing else.
export interface RequestRow {
  id: string;
  status:
    | 'pending_approval'
    | 'approved'
    | 'executing'
    | 'done'
    | 'cancelled'
    | 'rejected'
    | 'expired';
  requestedAt: string;
  expiresAt: string | null;
  graceUntil: string | null;
}
export interface AdminRow extends RequestRow {
  memberName: string;
  memberEmail: string;
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : (v instanceof Date ? v : new Date(String(v))).toISOString();

const toRow = (r: Record<string, unknown>): RequestRow => ({
  id: r.id as string,
  status: r.status as RequestRow['status'],
  requestedAt: iso(r.requested_at) as string,
  expiresAt: iso(r.expires_at),
  graceUntil: iso(r.grace_until),
});

type Json = Record<string, unknown>;

export function createErasureRepository() {
  const call = async (exec: Executor, query: ReturnType<typeof sql>): Promise<Json> =>
    ((await exec.execute(query)).rows[0] as { r: Json }).r;
  return {
    preview: (exec: Executor, tenantId: string, userId: string) =>
      call(exec, sql`select lms.privacy_erasure_preview(${tenantId}::uuid, ${userId}::uuid) as r`),

    /** the member's own latest request (or null): one statement */
    mine: (exec: Executor, tenantId: string, userId: string) =>
      call(exec, sql`select lms.privacy_erasure_mine(${tenantId}::uuid, ${userId}::uuid) as r`),

    async adminList(tx: Executor, limit: number): Promise<AdminRow[]> {
      const res = await tx.execute(
        sql`SELECT e.id, e.status, e.requested_at, e.expires_at, e.grace_until, i.display_name, i.email
              FROM lms.erasure_requests e
              JOIN lms.member_identity i ON i.tenant_id = e.tenant_id AND i.membership_id = e.membership_id
             ORDER BY (e.status IN ('pending_approval', 'approved')) DESC, e.requested_at DESC, e.id DESC LIMIT ${limit}`,
      );
      return res.rows.map((r) => ({
        ...toRow(r),
        memberName: r.display_name as string,
        memberEmail: r.email as string,
      }));
    },

    request: (
      exec: Executor,
      a: { tenantId: string; userId: string; ip: string | null; now: Date },
    ) =>
      call(
        exec,
        sql`select lms.privacy_erasure_request(${a.tenantId}::uuid, ${a.userId}::uuid, ${a.ip}::inet, ${a.now.toISOString()}::timestamptz) as r`,
      ),

    decide: (
      exec: Executor,
      a: {
        tenantId: string;
        id: string;
        actor: string;
        action: 'approve' | 'reject' | 'cancel';
        now: Date;
        ip: string | null;
      },
    ) =>
      call(
        exec,
        sql`select lms.privacy_erasure_decide(${a.tenantId}::uuid, ${a.id}::uuid, ${a.actor}::uuid, ${a.action}::text, ${a.now.toISOString()}::timestamptz, ${a.ip}::inet) as r`,
      ),

    async expire(exec: Executor, now: Date, limit: number): Promise<number> {
      const res = await exec.execute(
        sql`select lms.privacy_erasure_expire(${now.toISOString()}::timestamptz, ${limit}::int) as n`,
      );
      return Number((res.rows[0] as { n: number }).n);
    },

    async due(
      exec: Executor,
      now: Date,
      limit: number,
    ): Promise<{ tenantId: string; id: string }[]> {
      const res = await exec.execute(
        sql`select r_tenant, r_id from lms.privacy_erasure_due(${now.toISOString()}::timestamptz, ${limit}::int)`,
      );
      return res.rows.map((r) => ({ tenantId: r.r_tenant as string, id: r.r_id as string }));
    },

    prepare: (exec: Executor, tenantId: string, id: string, now: Date) =>
      call(
        exec,
        sql`select lms.privacy_erasure_prepare(${tenantId}::uuid, ${id}::uuid, ${now.toISOString()}::timestamptz) as r`,
      ),

    execute: (
      exec: Executor,
      a: { tenantId: string; id: string; now: Date; email: string; hash: Buffer; kid: string },
    ) =>
      call(
        exec,
        sql`select lms.privacy_erasure_execute(${a.tenantId}::uuid, ${a.id}::uuid, ${a.now.toISOString()}::timestamptz, ${a.email}::text,
              ${`\\x${a.hash.toString('hex')}`}::bytea, ${a.kid}::text) as r`,
      ),

    async ledgerPending(exec: Executor, limit: number) {
      const res = await exec.execute(
        sql`select r_id, r_tenant, r_membership, r_user, r_at from lms.privacy_erasure_ledger_pending(${limit}::int)`,
      );
      return res.rows.map((r) => ({
        requestId: r.r_id as string,
        tenantId: r.r_tenant as string,
        membershipId: r.r_membership as string,
        userId: r.r_user as string,
        at: iso(r.r_at) as string,
      }));
    },

    async ledgerDone(exec: Executor, ids: string[], now: Date): Promise<number> {
      const res = await exec.execute(
        sql`select lms.privacy_erasure_ledger_done(${`{${ids.join(',')}}`}::uuid[], ${now.toISOString()}::timestamptz) as n`,
      );
      return Number((res.rows[0] as { n: number }).n);
    },

    reapplyPrepare: (
      exec: Executor,
      a: { tenantId: string; membershipId: string; userId: string },
    ) =>
      call(
        exec,
        sql`select lms.privacy_erasure_reapply_prepare(${a.tenantId}::uuid, ${a.membershipId}::uuid, ${a.userId}::uuid) as r`,
      ),

    reapply: (
      exec: Executor,
      a: {
        tenantId: string;
        membershipId: string;
        userId: string;
        requestId: string;
        at: string;
        now: Date;
        email: string;
        hash: Buffer;
        kid: string;
      },
    ) =>
      call(
        exec,
        sql`select lms.privacy_erasure_reapply(${a.tenantId}::uuid, ${a.membershipId}::uuid, ${a.userId}::uuid, ${a.requestId}::uuid,
              ${a.at}::timestamptz, ${a.now.toISOString()}::timestamptz, ${a.email}::text, ${`\\x${a.hash.toString('hex')}`}::bytea, ${a.kid}::text) as r`,
      ),
  };
}
export type ErasureRepository = ReturnType<typeof createErasureRepository>;
