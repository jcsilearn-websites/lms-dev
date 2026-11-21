import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

// SQL only. Every change is a definer function (migration 0062): the app role can read its own export rows and nothing else.
export interface ExportRow {
  id: string;
  status: 'queued' | 'building' | 'ready' | 'failed' | 'expired';
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  counts: Record<string, number> | null;
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : (v instanceof Date ? v : new Date(String(v))).toISOString();

interface RequestResult {
  result: string;
  id?: string;
  status?: string;
  requestedAt?: string;
}

export function createPrivacyRepository() {
  return {
    async list(tx: Executor, limit: number): Promise<ExportRow[]> {
      const res = await tx.execute(
        sql`SELECT id, status, requested_at, ready_at, expires_at, size_bytes, counts
              FROM lms.data_exports ORDER BY requested_at DESC, id DESC LIMIT ${limit}`,
      );
      return res.rows.map((r) => ({
        id: r.id as string,
        status: r.status as ExportRow['status'],
        requestedAt: iso(r.requested_at) as string,
        readyAt: iso(r.ready_at),
        expiresAt: iso(r.expires_at),
        sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
        counts: (r.counts as Record<string, number> | null) ?? null,
      }));
    },

    async request(
      exec: Executor,
      a: { tenantId: string; userId: string; ip: string | null; now: Date },
    ): Promise<RequestResult> {
      const res = await exec.execute(
        sql`select lms.privacy_export_request(${a.tenantId}::uuid, ${a.userId}::uuid, ${a.ip}::inet, ${a.now.toISOString()}::timestamptz) as r`,
      );
      return (res.rows[0] as { r: RequestResult }).r;
    },

    async claim(exec: Executor, tenantId: string, id: string, now: Date) {
      const res = await exec.execute(
        sql`select lms.privacy_export_claim(${tenantId}::uuid, ${id}::uuid, ${now.toISOString()}::timestamptz) as r`,
      );
      return (res.rows[0] as { r: { result: string; userId?: string; status?: string } }).r;
    },

    async collect(exec: Executor, tenantId: string, id: string): Promise<Record<string, unknown>> {
      const res = await exec.execute(
        sql`select lms.privacy_export_collect(${tenantId}::uuid, ${id}::uuid) as r`,
      );
      return (res.rows[0] as { r: Record<string, unknown> }).r;
    },

    async finish(
      exec: Executor,
      a: {
        tenantId: string;
        id: string;
        key: string;
        size: number;
        sha256: string;
        counts: Record<string, number>;
        now: Date;
        ttlSeconds: number;
      },
    ): Promise<string> {
      const res = await exec.execute(
        sql`select lms.privacy_export_finish(${a.tenantId}::uuid, ${a.id}::uuid, ${a.key}::text, ${a.size}::bigint, ${a.sha256}::text,
              ${JSON.stringify(a.counts)}::jsonb, ${a.now.toISOString()}::timestamptz, ${a.ttlSeconds}::int) as r`,
      );
      return (res.rows[0] as { r: string }).r;
    },

    async fail(exec: Executor, tenantId: string, id: string, reason: string): Promise<string> {
      const res = await exec.execute(
        sql`select lms.privacy_export_fail(${tenantId}::uuid, ${id}::uuid, ${reason}::text) as r`,
      );
      return (res.rows[0] as { r: string }).r;
    },

    async download(
      exec: Executor,
      a: { tenantId: string; userId: string; id: string; now: Date; ip: string | null },
    ): Promise<{ result: string; key?: string; expiresAt?: string }> {
      const res = await exec.execute(
        sql`select lms.privacy_export_download(${a.tenantId}::uuid, ${a.userId}::uuid, ${a.id}::uuid, ${a.now.toISOString()}::timestamptz, ${a.ip}::inet) as r`,
      );
      return (res.rows[0] as { r: { result: string; key?: string; expiresAt?: string } }).r;
    },

    async expireList(
      exec: Executor,
      now: Date,
      limit: number,
    ): Promise<{ id: string; tenantId: string; key: string }[]> {
      const res = await exec.execute(
        sql`select r_id, r_tenant, r_key from lms.privacy_export_expire_list(${now.toISOString()}::timestamptz, ${limit}::int)`,
      );
      return res.rows.map((r) => ({
        id: r.r_id as string,
        tenantId: r.r_tenant as string,
        key: r.r_key as string,
      }));
    },

    async purged(exec: Executor, ids: string[]): Promise<number> {
      const res = await exec.execute(
        sql`select lms.privacy_export_purged(${`{${ids.join(',')}}`}::uuid[]) as n`,
      );
      return Number((res.rows[0] as { n: number }).n);
    },
  };
}
export type PrivacyRepository = ReturnType<typeof createPrivacyRepository>;
