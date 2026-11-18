import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

export function createRateLimitRepository() {
  return {
    /** ONE statement: add `delta` hits to the key's window and return the total and the time left. */
    async hit(
      db: Executor,
      key: string,
      windowMs: number,
      delta: number,
    ): Promise<{ hits: number; ttlMs: number }> {
      const result = await db.execute(
        sql`select hits, ttl_ms from lms.rate_limit_hit(${key}::text, ${windowMs}::int, ${delta}::int)`,
      );
      const row = result.rows[0] as { hits: number; ttl_ms: number } | undefined;
      if (!row) throw new Error('rate_limit_hit returned no row');
      return { hits: Number(row.hits), ttlMs: Number(row.ttl_ms) };
    },

    async purge(db: Executor, batch: number): Promise<number> {
      const result = await db.execute(sql`select lms.rate_limit_purge(${batch}::int) as n`);
      return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
    },
  };
}
export type RateLimitRepository = ReturnType<typeof createRateLimitRepository>;
