import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

export interface OpsMetricRow {
  metric: string;
  label: string;
  value: number;
}

export function createOpsRepository() {
  return {
    /** ONE definer call (lms.ops_metrics): counts and ages across colleges, no names or ids. */
    async metrics(db: Executor): Promise<OpsMetricRow[]> {
      const result = await db.execute(sql`select metric, label, value from lms.ops_metrics()`);
      return (result.rows as { metric: string; label: string; value: number | string }[]).map(
        (r) => ({ metric: r.metric, label: r.label, value: Number(r.value) }),
      );
    },
  };
}
export type OpsRepository = ReturnType<typeof createOpsRepository>;
