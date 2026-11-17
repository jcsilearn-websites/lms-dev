/**
 * The send-rate limit per provider, per worker process: a token bucket (EMAIL_RATE_PER_SECOND, burst of one second's worth).
 * `take()` resolves when a send may start. With N worker instances the provider sees at most N x the rate: set the env value
 * to the provider's limit divided by the number of workers (ADR 0021). Aborting the signal rejects a waiting take().
 */
export interface RateLimiter {
  take(signal?: AbortSignal): Promise<void>;
}

export function createTokenBucket(
  ratePerSecond: number,
  opts: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): RateLimiter {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }));
  const capacity = Math.max(1, ratePerSecond);
  let tokens = capacity;
  let last = now();
  // one waiter at a time keeps the order fair (first come, first served)
  let queue: Promise<void> = Promise.resolve();

  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) / 1000) * ratePerSecond);
    last = t;
  };

  return {
    take(signal) {
      const run = queue.then(async () => {
        for (;;) {
          if (signal?.aborted) throw new Error('aborted');
          refill();
          if (tokens >= 1) {
            tokens -= 1;
            return;
          }
          await sleep(Math.ceil(((1 - tokens) / ratePerSecond) * 1000), signal);
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
