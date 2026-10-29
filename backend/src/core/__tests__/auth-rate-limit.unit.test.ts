import { describe, expect, it } from 'vitest';
import { createWindowLimiter } from '../auth-rate-limit';

describe('window limiter', () => {
  it('allows max hits per window, then returns the seconds to wait, then resets', () => {
    let t = 0;
    const limiter = createWindowLimiter({ max: 2, windowMs: 60_000, now: () => t });
    expect([limiter.hit('k'), limiter.hit('k'), limiter.hit('k')]).toEqual([0, 0, 60]);
    t = 30_000;
    expect(limiter.hit('k')).toBe(30);
    expect(limiter.hit('other')).toBe(0); // keys are independent
    t = 60_001;
    expect(limiter.hit('k')).toBe(0); // new window
  });

  it('is bounded: flooding with distinct keys cannot grow memory without limit', () => {
    const limiter = createWindowLimiter({ max: 5, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) limiter.hit(`key-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });
});
