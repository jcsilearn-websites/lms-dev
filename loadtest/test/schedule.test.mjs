import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrivalOffsets,
  launchAt,
  mapLimit,
  mulberry32,
  paceLoop,
  poissonOffsets,
  ratePacer,
  scaled,
  scaledMs,
} from '../src/schedule.mjs';

/** A fake clock: `wait(ms)` advances time and resolves at once, so the tests take no time and need no luck. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms) => {
      t += Math.max(0, ms);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

test('the seeded generator is reproducible, in [0, 1), and differs between seeds', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(
    xs,
    Array.from({ length: 1000 }, () => b()),
  );
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, mulberry32(43)));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
});

test('scaling: at least one, capped, and durations never below the floor', () => {
  assert.equal(scaled(1500, 0.1), 150);
  assert.equal(scaled(1500, 0.0001), 1);
  assert.equal(scaled(1500, 1, 40), 40);
  assert.equal(scaledMs(30_000, 0.1), 3000);
  assert.equal(scaledMs(1000, 0.001, 200), 200);
});

test('uniform arrivals fill the window evenly, ascending, one per slot', () => {
  const o = arrivalOffsets(100, 60, 'uniform', mulberry32(1));
  assert.equal(o.length, 100);
  assert.deepEqual(
    o,
    [...o].sort((a, b) => a - b),
  );
  for (const [i, x] of o.entries())
    assert.ok(x >= i * 600 && x < (i + 1) * 600, `offset ${i} = ${x}`);
});

test('the deadline curve piles arrivals up at the end: most arrive in the last fifth', () => {
  const o = arrivalOffsets(5000, 600, 'deadline', mulberry32(2));
  const lastFifth = o.filter((x) => x >= 480_000).length / o.length;
  // density t^2: P(last 20 %) = 1 - 0.8^3 = 0.488
  assert.ok(lastFifth > 0.45 && lastFifth < 0.53, `last fifth: ${lastFifth}`);
  assert.ok(o.every((x) => x >= 0 && x <= 600_000));
});

test('the morning rush peaks at its mode (30 % of the window) and thins out on both sides', () => {
  const o = arrivalOffsets(20_000, 100, 'peak', mulberry32(3));
  const bucket = (from, to) => o.filter((x) => x >= from * 1000 && x < to * 1000).length;
  assert.ok(bucket(25, 35) > bucket(0, 10) * 2);
  assert.ok(bucket(25, 35) > bucket(90, 100) * 4);
  assert.throws(() => arrivalOffsets(3, 10, 'zigzag'), /unknown arrival shape/);
});

test('Poisson arrivals have the requested rate and stay inside the window', () => {
  const o = poissonOffsets(50, 100, mulberry32(4));
  assert.ok(o.every((x) => x < 100_000));
  assert.ok(Math.abs(o.length - 5000) < 300, `${o.length} arrivals`);
});

test('launchAt starts each task at its offset, in order, and does not wait for a slow one (open model)', async () => {
  const started = [];
  const t0 = performance.now();
  await launchAt([0, 30, 60], async (i) => {
    started.push([i, performance.now() - t0]);
    if (i === 0) await new Promise((r) => setTimeout(r, 120)); // task 0 is slow: the others still start on their own schedule
  });
  assert.deepEqual(
    started.map(([i]) => i),
    [0, 1, 2],
  );
  assert.ok(
    started[1][1] < 110 && started[2][1] < 140,
    `starts at ${started.map(([, t]) => Math.round(t))}`,
  );
});

test('launchAt reports the lag of a generator that started late (a clock that jumped past the planned time)', async () => {
  let t = 0;
  const lags = [];
  await launchAt([100], async () => {}, {
    now: () => t,
    wait: async () => {
      t = 350;
    },
    onLag: (ms) => lags.push(ms),
  });
  assert.deepEqual(lags, [250]);
  // on time: no lag
  t = 0;
  const on = [];
  await launchAt([100], async () => {}, {
    now: () => t,
    wait: async (ms) => {
      t += ms;
    },
    onLag: (ms) => on.push(ms),
  });
  assert.deepEqual(on, [0]);
});

test('a failing task is reported and does not stop the others', async () => {
  const clock = fakeClock();
  const errors = [];
  const done = [];
  await launchAt(
    [0, 10, 20],
    async (i) => {
      if (i === 1) throw new Error('boom');
      done.push(i);
    },
    { now: clock.now, wait: clock.wait, onError: (e, i) => errors.push([e.message, i]) },
  );
  assert.deepEqual(done, [0, 2]);
  assert.deepEqual(errors, [['boom', 1]]);
});

test('paceLoop keeps its cadence without drift: a slow call is followed by a shorter wait', async () => {
  const clock = fakeClock();
  const at = [];
  const n = await paceLoop(
    async (tick) => {
      at.push(clock.now());
      clock.advance(tick === 1 ? 700 : 0);
    },
    1000,
    { until: () => clock.now() >= 5000, now: clock.now, wait: clock.wait },
  );
  assert.deepEqual(at, [0, 1000, 2000, 3000, 4000]);
  assert.equal(n, 5);
});

test('paceLoop jitter spreads ticks by at most the given fraction of the period', async () => {
  const clock = fakeClock();
  const at = [];
  await paceLoop(
    async () => {
      at.push(clock.now());
    },
    1000,
    {
      until: () => clock.now() >= 20_000,
      now: clock.now,
      wait: clock.wait,
      rng: mulberry32(9),
      jitter: 0.2,
    },
  );
  for (const [i, t] of at.entries())
    assert.ok(Math.abs(t - i * 1000) <= 200 + 1e-6, `tick ${i} at ${t}`);
  assert.ok(
    new Set(at.map((t, i) => Math.round(t - i * 1000))).size > 3,
    'ticks are not all in step',
  );
});

test('mapLimit never runs more than the limit at once and keeps the order of the results', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([...Array(25).keys()], 4, async (x) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    return x * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(
    out,
    [...Array(25).keys()].map((x) => x * 2),
  );
});

test('ratePacer hands out slots at the requested rate', async () => {
  const clock = fakeClock();
  const take = ratePacer(10, { now: clock.now, wait: clock.wait }); // one every 100 ms
  const times = [];
  for (let i = 0; i < 5; i++) {
    await take();
    times.push(Math.round(clock.now()));
  }
  assert.deepEqual(times, [0, 100, 200, 300, 400]);
});
