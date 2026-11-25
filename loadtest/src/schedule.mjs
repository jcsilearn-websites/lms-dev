// Scheduling helpers: a seeded random generator, arrival curves, an open-model launcher that measures how late it started each task, a drift-free
// pacing loop, and the scaling rules (how many users, how long). Everything takes its clock and random source as parameters, so the unit tests
// (test/schedule.test.mjs) need neither time nor luck.

/** A small seeded generator (mulberry32): the same seed gives the same run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** How many users a scale gives: at least one, and never more than `cap`. */
export function scaled(base, scale, cap = Number.POSITIVE_INFINITY) {
  return Math.min(cap, Math.max(1, Math.round(base * scale)));
}

/** A duration shrunk by the time scale (a test of 1/10 the length: 30 s heartbeats become 3 s), never below `floorMs`. */
export function scaledMs(ms, timeScale, floorMs = 50) {
  return Math.max(floorMs, Math.round(ms * timeScale));
}

/**
 * Start offsets (ms, ascending) of `n` arrivals inside `seconds`:
 *   uniform   evenly spread, each at a random point of its own slot
 *   peak      a morning rush: a triangular density that rises to its mode (at 30 % of the window) and falls away
 *   deadline  a hand-in: the density grows towards the END of the window (offset = window x u^(1/3)), most arrive in the last minutes
 */
export function arrivalOffsets(n, seconds, shape = 'uniform', rng = Math.random) {
  const total = seconds * 1000;
  const out = [];
  for (let i = 0; i < n; i++) {
    let x;
    if (shape === 'uniform') x = (i + rng()) / n;
    else if (shape === 'deadline') x = rng() ** (1 / 3);
    else if (shape === 'peak') {
      const mode = 0.3;
      const u = rng();
      x = u < mode ? Math.sqrt(u * mode) : 1 - Math.sqrt((1 - u) * (1 - mode));
    } else throw new Error(`unknown arrival shape "${shape}"`);
    out.push(x * total);
  }
  return out.sort((a, b) => a - b);
}

/** Poisson arrivals at `perSecond` for `seconds`: exponential gaps. */
export function poissonOffsets(perSecond, seconds, rng = Math.random) {
  const out = [];
  let t = 0;
  for (;;) {
    t += (-Math.log(1 - rng()) / perSecond) * 1000;
    if (t >= seconds * 1000) return out;
    out.push(t);
  }
}

/**
 * Runs `task(index, plannedMs)` at each offset (an OPEN model: a slow server does not slow the arrivals). `onLag(ms)` gets how late each task actually
 * started: when that grows the load generator, not the server, is the bottleneck (coordinated omission, reported by `verdicts`). Resolves when all
 * tasks have finished; a task that throws is passed to `onError` and does not stop the others.
 */
export async function launchAt(
  offsets,
  task,
  { onLag, onError, now = () => performance.now(), wait = sleep } = {},
) {
  const t0 = now();
  const running = offsets.map(async (offset, index) => {
    const delay = offset - (now() - t0);
    if (delay > 0) await wait(delay);
    onLag?.(Math.max(0, now() - t0 - offset));
    try {
      await task(index, offset);
    } catch (err) {
      onError?.(err, index);
    }
  });
  await Promise.all(running);
}

/**
 * Calls `fn(tick)` every `everyMs` until `until()` is true, without drift: the next call is planned from the START of the loop, not from the end of
 * the last call, so a slow call is followed by a shorter wait. `jitter` (0-1) spreads the ticks of many users so they do not march in step.
 */
export async function paceLoop(
  fn,
  everyMs,
  {
    until = () => false,
    rng = Math.random,
    jitter = 0,
    now = () => performance.now(),
    wait = sleep,
  } = {},
) {
  const t0 = now();
  let tick = 0;
  while (!until()) {
    const planned = tick * everyMs + (jitter > 0 ? (rng() * 2 - 1) * jitter * everyMs : 0);
    const delay = planned - (now() - t0);
    if (delay > 0) await wait(delay);
    if (until()) return tick;
    await fn(tick);
    tick++;
  }
  return tick;
}

/** Runs `worker(item)` over `items` with at most `limit` at once (the preparation phase: signing in thousands of users politely). */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** A token pacer: `take()` resolves when the next of `perSecond` slots is free (used to keep preparation logins below the sign-in rate limit). */
export function ratePacer(perSecond, { now = () => performance.now(), wait = sleep } = {}) {
  const gap = 1000 / perSecond;
  let next = now();
  return async function take() {
    const slot = Math.max(next, now());
    next = slot + gap;
    const delay = slot - now();
    if (delay > 0) await wait(delay);
  };
}
