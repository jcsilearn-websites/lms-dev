import type { RateLimitStore } from '../../core/rate-limit';
import type { Database } from '../../db/client';
import type { RateLimitRepository } from './ratelimit.repository';

export interface RateLimitService {
  /** The shared store (PostgreSQL): one autocommit round trip per call. */
  store: RateLimitStore;
  /** Deletes windows that ended more than a minute ago; returns how many. */
  purge(batch?: number): Promise<number>;
}

export function createRateLimitService(deps: {
  db: Database;
  rateLimitRepo: RateLimitRepository;
}): RateLimitService {
  const { db, rateLimitRepo } = deps;
  return {
    store: {
      async hit(key, windowMs, delta = 1) {
        const r = await db.withoutTenant((tx) =>
          rateLimitRepo.hit(tx, key.slice(0, 300), windowMs, Math.max(1, Math.min(delta, 100_000))),
        );
        return { count: r.hits, ttlMs: r.ttlMs };
      },
    },
    async purge(batch = 1000) {
      let total = 0;
      for (let i = 0; i < 100; i++) {
        const n = await db.withoutTenant((tx) => rateLimitRepo.purge(tx, batch));
        total += n;
        if (n < batch) break;
      }
      return total;
    },
  };
}
