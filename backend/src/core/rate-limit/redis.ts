import type { RateLimitHit, RateLimitStore } from './store';

/**
 * Redis (Memorystore on GCP) rate-limit store: NOT BUILT. It could not be tested here (no Redis, no Docker), and an untested limiter
 * is worse than none. TODO(GCP step): implement `hit` as one atomic script,
 *     local n = redis.call('INCRBY', KEYS[1], ARGV[2]);
 *     if n == tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end;
 *     return {n, redis.call('PTTL', KEYS[1])}
 * and run the shared contract test (core/__tests__/rate-limit.unit.test.ts `storeContract`) against a real instance. Choose it over the
 * PostgreSQL store only when the limiter's database load shows up in the measurements (docs/adr/0022).
 */
export function createRedisRateLimitStore(): RateLimitStore {
  return {
    hit(): Promise<RateLimitHit> {
      return Promise.reject(
        new Error('the Redis rate-limit store is not implemented (docs/adr/0022)'),
      );
    },
  };
}
