import { describe, expect, it, vi } from 'vitest';
import {
  createBatchedLimiter,
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  createStrictLimiter,
  type RateLimitStore,
} from '../rate-limit';
import { storeContract } from './store-contract';

describe('memory store', () => {
  it('meets the store contract and bounds its memory', async () => {
    let now = 1_000_000;
    await storeContract(() => createMemoryRateLimitStore({ now: () => now }), {
      advance: (ms) => {
        now += ms;
      },
    });
    const small = createMemoryRateLimitStore({ maxKeys: 10, now: () => now });
    for (let i = 0; i < 100; i++) await small.hit(`k${i}`, 60_000);
    expect(small.size()).toBeLessThanOrEqual(10);
  });
});

describe('batched (local tier) limiter', () => {
  const clock = () => {
    let now = 5_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('decides locally and never touches the shared store on a single hit', async () => {
    const shared = createMemoryRateLimitStore();
    const spy = vi.spyOn(shared, 'hit');
    const c = clock();
    const limiter = createBatchedLimiter({ shared, now: c.now });
    expect(limiter.hit('k', 60_000, 100).count).toBe(1);
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });

  it('counts per key in a fixed window and limits above max', () => {
    const c = clock();
    const limiter = createBatchedLimiter({ shared: null, now: c.now });
    const counts = Array.from({ length: 5 }, () => limiter.hit('k', 1000, 3).count);
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    c.advance(1001);
    expect(limiter.hit('k', 1000, 3).count).toBe(1);
  });

  it('folds hits into the shared store in batches (a tenth of the limit), not one by one', async () => {
    const shared = createMemoryRateLimitStore();
    const spy = vi.spyOn(shared, 'hit');
    const c = clock();
    const limiter = createBatchedLimiter({ shared, now: c.now });
    for (let i = 0; i < 100; i++) {
      limiter.hit('k', 60_000, 1000);
      if (i % 10 === 9) await settle();
    }
    await settle();
    // 100 hits with a limit of 1,000 -> batches of 100: at most a couple of calls, never 100
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    const total = (await shared.hit('k', 60_000, 0)).count;
    expect(total).toBeGreaterThan(0);
  });

  it('two instances see each other: the limit holds across them within the batch slack', async () => {
    const shared = createMemoryRateLimitStore();
    const c = clock();
    const a = createBatchedLimiter({ shared, now: c.now });
    const b = createBatchedLimiter({ shared, now: c.now });
    const max = 100;
    let admitted = 0;
    for (let i = 0; i < 400; i++) {
      const inst = i % 2 === 0 ? a : b;
      if (inst.hit('k', 60_000, max).count <= max) admitted++;
      if (i % 5 === 0) await settle();
    }
    // exact would be 100; the slack is one batch (a tenth of the limit) per instance
    expect(admitted).toBeGreaterThanOrEqual(max);
    expect(admitted).toBeLessThanOrEqual(max + 2 * Math.ceil(max / 10) + 2);
  });

  it('keeps working when the shared store fails (counts locally, reports the error, loses no hits)', async () => {
    const failing: RateLimitStore = { hit: () => Promise.reject(new Error('db down')) };
    const onSyncError = vi.fn();
    const c = clock();
    const limiter = createBatchedLimiter({ shared: failing, now: c.now, onSyncError });
    let last = 0;
    for (let i = 0; i < 50; i++) {
      last = limiter.hit('k', 60_000, 100).count;
      if (i % 5 === 0) await settle();
    }
    await settle();
    expect(onSyncError).toHaveBeenCalled();
    expect(last).toBe(50);
  });

  it('is bounded in memory', () => {
    const limiter = createBatchedLimiter({ shared: null, maxKeys: 50 });
    for (let i = 0; i < 1000; i++) limiter.hit(`k${i}`, 60_000, 10);
    expect(limiter.size()).toBeLessThanOrEqual(50);
  });
});

describe('strict limiter', () => {
  it('counts in the shared store on every call', async () => {
    const shared = createMemoryRateLimitStore();
    const spy = vi.spyOn(shared, 'hit');
    const strict = createStrictLimiter({ shared });
    expect((await strict.hit('k', 60_000)).count).toBe(1);
    expect((await strict.hit('k', 60_000)).count).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('degrades to per-instance counting when the store fails (a limiter outage is not a login outage)', async () => {
    const onError = vi.fn();
    const strict = createStrictLimiter({
      shared: { hit: () => Promise.reject(new Error('down')) },
      onError,
    });
    expect((await strict.hit('k', 60_000)).count).toBe(1);
    expect((await strict.hit('k', 60_000)).count).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('the Redis store is an explicit stub', async () => {
    await expect(createRedisRateLimitStore().hit('k', 1000)).rejects.toThrow(/not implemented/);
  });
});
