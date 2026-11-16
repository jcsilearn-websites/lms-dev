import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

// SQL only. Metering is computed and frozen by the definer functions of migration 0045 (usage_compute / usage_close_due /
// platform_usage); nothing here reads another college's rows except through platform_usage, which returns aggregates only.
export interface UsageDbRow {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  provisional: boolean;
  revision: number;
  time_zone: string;
  billable_learners: number;
  active_users: number;
  video_seconds: string | number;
  video_gb_estimate: string | number;
  storage_bytes: string | number;
  offerings: number;
  active_offerings: number;
  members: number;
}

export function createUsageRepository() {
  return {
    async platformUsage(
      conn: Executor,
      actorId: string,
      month: string,
      mix: Record<string, number>,
    ): Promise<UsageDbRow[]> {
      const r = await conn.execute(
        sql`SELECT * FROM lms.platform_usage(${actorId}::uuid, ${month}::date, now(), ${JSON.stringify(mix)}::jsonb)`,
      );
      return r.rows as unknown as UsageDbRow[];
    },
    /** Closes every month that ended (in each college's zone) and has no snapshot. Idempotent. */
    async closeDue(conn: Executor, now: Date, mix: Record<string, number>): Promise<number> {
      const r = await conn.execute(
        sql`SELECT lms.usage_close_due(${now.toISOString()}::timestamptz, ${JSON.stringify(mix)}::jsonb) AS n`,
      );
      return Number((r.rows[0] as { n: number | string }).n);
    },
  };
}
export type UsageRepository = ReturnType<typeof createUsageRepository>;
