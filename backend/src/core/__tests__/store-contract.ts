import { expect } from 'vitest';
import type { RateLimitStore } from '../rate-limit';

/** The contract every store must meet (the PostgreSQL store runs it in test/rate-limit.shared.test.ts). */
export async function storeContract(
  make: () => RateLimitStore,
  clock?: { advance(ms: number): void },
) {
  const s = make();
  const key = `contract-${Math.random()}`;
  expect((await s.hit(key, 60_000, 1)).count).toBe(1);
  const second = await s.hit(key, 60_000, 1);
  expect(second.count).toBe(2);
  expect(second.ttlMs).toBeGreaterThan(0);
  expect(second.ttlMs).toBeLessThanOrEqual(60_000);
  expect((await s.hit(key, 60_000, 5)).count).toBe(7); // a batch adds its whole delta
  expect((await s.hit(`${key}-other`, 60_000, 1)).count).toBe(1); // keys are independent
  if (clock) {
    clock.advance(61_000);
    expect((await s.hit(key, 60_000, 1)).count).toBe(1); // a new window opens
  }
}
