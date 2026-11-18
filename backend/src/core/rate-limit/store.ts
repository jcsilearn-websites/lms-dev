// The RATE-LIMIT STORE interface (step 14a, docs/adr/0022-shared-rate-limiting.md). A store counts hits per key in a fixed window.
// Implementations: memory (development, tests, and the fallback when the shared store fails), PostgreSQL (the production default: an
// UNLOGGED table behind one definer function, modules/ratelimit) and Redis (a stub: see redis.ts).

export interface RateLimitHit {
  /** hits in the current window, this one (and `delta - 1` batched ones) included */
  count: number;
  /** milliseconds until the window ends */
  ttlMs: number;
}

export interface RateLimitStore {
  /** Adds `delta` hits (default 1) to `key`'s window of `windowMs` and returns the total. */
  hit(key: string, windowMs: number, delta?: number): Promise<RateLimitHit>;
}

/** In-process fixed-window counters. Bounded: expired windows are pruned, and the oldest keys dropped when still full. */
export function createMemoryRateLimitStore(
  opts: { maxKeys?: number; now?: () => number } = {},
): RateLimitStore & { size(): number } {
  const maxKeys = opts.maxKeys ?? 50_000;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, windowMs, delta = 1) {
      const t = now();
      const e = windows.get(key);
      if (!e || e.resetAt <= t) {
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
          while (windows.size >= maxKeys) {
            const oldest = windows.keys().next().value;
            if (oldest === undefined) break;
            windows.delete(oldest);
          }
        }
        windows.set(key, { count: delta, resetAt: t + windowMs });
        return { count: delta, ttlMs: windowMs };
      }
      e.count += delta;
      return { count: e.count, ttlMs: Math.max(0, e.resetAt - t) };
    },
    size: () => windows.size,
  };
}
