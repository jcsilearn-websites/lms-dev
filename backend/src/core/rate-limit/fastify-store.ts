import type { BatchedLimiter } from './batched';

// Adapter for @fastify/rate-limit: its `store` option takes a class with `incr(key, cb, timeWindow, max)`, `read` and `child(routeOptions)`.
// Every route gets its own child with its own key prefix (the plugin's default stores are per route, so keys are not route-qualified).
// The decision is the local tier's (synchronous, no database round trip); see batched.ts.

interface StoreOptions {
  routeInfo?: { method?: string | string[]; url?: string };
}

type Callback = (err: Error | null, res: { current: number; ttl: number }) => void;

export function createFastifyRateLimitStore(limiter: BatchedLimiter) {
  class SharedRateLimitStore {
    private readonly prefix: string;
    // the plugin builds the root store with its options object; routes get children carrying their own prefix
    constructor(arg?: string | object) {
      this.prefix = typeof arg === 'string' ? arg : '';
    }
    incr(key: string, cb: Callback, timeWindow: number, max: number): void {
      const r = limiter.hit(`${this.prefix}|${key}`, timeWindow, max);
      cb(null, { current: r.count, ttl: r.ttlMs });
    }
    read(key: string, cb: Callback, timeWindow: number, max: number): void {
      // the application never peeks without counting; counting is the conservative reading of a peek
      this.incr(key, cb, timeWindow, max);
    }
    child(routeOptions: object): SharedRateLimitStore {
      const info = (routeOptions as StoreOptions).routeInfo;
      const method = Array.isArray(info?.method) ? info.method.join(',') : (info?.method ?? '');
      return new SharedRateLimitStore(`${method} ${info?.url ?? ''}`);
    }
  }
  return SharedRateLimitStore;
}
