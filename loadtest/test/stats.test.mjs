import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTable, Histogram, percentileOfSorted, Recorder, verdicts } from '../src/stats.mjs';

test('nearest-rank percentiles of a known series', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentileOfSorted(s, 50), 50);
  assert.equal(percentileOfSorted(s, 90), 90);
  assert.equal(percentileOfSorted(s, 95), 95);
  assert.equal(percentileOfSorted(s, 99), 99);
  assert.equal(percentileOfSorted(s, 100), 100);
  assert.equal(percentileOfSorted(s, 0), 1);
  // 10 samples: p95 is the 10th (ceil(9.5) = 10), p50 the 5th
  const t = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentileOfSorted(t, 95), 100);
  assert.equal(percentileOfSorted(t, 50), 50);
  assert.equal(percentileOfSorted([7], 99), 7);
  assert.ok(Number.isNaN(percentileOfSorted([], 50)));
});

test('a histogram keeps count, mean, min and max exactly and percentiles from the samples', () => {
  const h = new Histogram(1000, 1);
  for (let i = 1; i <= 200; i++) h.record(i);
  const snap = h.snapshot();
  assert.equal(snap.count, 200);
  assert.equal(snap.mean, 100.5);
  assert.equal(snap.min, 1);
  assert.equal(snap.max, 200);
  assert.equal(snap.p50, 100);
  assert.equal(snap.p99, 198);
  assert.equal(snap.sampled, false);
});

test('past its capacity a histogram samples uniformly, deterministically for one seed, and the exact figures stay exact', () => {
  const fill = (seed) => {
    const h = new Histogram(500, seed);
    for (let i = 1; i <= 20_000; i++) h.record(i);
    return h;
  };
  const a = fill(7);
  const b = fill(7);
  const c = fill(8);
  assert.equal(a.samples.length, 500);
  assert.deepEqual(a.samples, b.samples, 'the same seed gives the same sample');
  assert.notDeepEqual(a.samples, c.samples);
  const snap = a.snapshot();
  assert.equal(snap.count, 20_000);
  assert.equal(snap.max, 20_000);
  assert.equal(snap.mean, 10_000.5);
  assert.equal(snap.sampled, true);
  // a uniform sample of 1..20000: the median is near 10000 (a sample of 500 is within a few per cent)
  assert.ok(Math.abs(snap.p50 - 10_000) < 1500, `p50 ${snap.p50}`);
});

test('the recorder groups by label, counts statuses and transport errors, and counts 5xx and status 0 as failures', () => {
  const r = new Recorder();
  for (let i = 0; i < 90; i++) r.record('GET /a', 10 + i, 200);
  for (let i = 0; i < 6; i++) r.record('GET /a', 500, 503);
  r.record('GET /a', 30_000, 0, { error: 'UND_ERR_HEADERS_TIMEOUT' });
  r.record('GET /a', 5, 404); // a client error is an answer, not a failure of the server
  r.record('GET /a', 5, 403);
  r.record('GET /a', 5, 429);
  r.record('POST /b', 20, 201, { bytes: 1234 });
  const rows = r.summary();
  const a = rows.find((x) => x.label === 'GET /a');
  assert.equal(a.count, 100);
  assert.equal(a.refused, 2);
  assert.equal(a.failed, 7);
  assert.deepEqual(a.statuses, { 0: 1, 200: 90, 403: 1, 404: 1, 429: 1, 503: 6 });
  assert.deepEqual(a.errors, { UND_ERR_HEADERS_TIMEOUT: 1 });
  assert.equal(rows.find((x) => x.label === 'POST /b').bytes, 1234);
  assert.equal(rows[0].label, 'GET /a', 'sorted by count');
});

test('verdicts: the error rate limit, and a saturated GENERATOR is called out', () => {
  const rows = [
    { label: 'GET /a', count: 1000, failed: 5 },
    { label: '~lag', count: 500, failed: 500 },
  ];
  const ok = verdicts(rows, { lag: { count: 10, p95: 200, max: 400 }, maxErrorRate: 0.01 });
  assert.equal(ok[0].ok, true, 'labels starting with ~ are not requests');
  assert.equal(ok[1].ok, true, 'nothing was refused');
  assert.equal(ok[2].ok, true, 'the generator kept up');
  // the first video run: segments answered 403 for a token that had expired, and the old verdict called that fine
  const refusedRows = [
    { label: 'GET segment', count: 100, failed: 0, refused: 60, statuses: { 200: 40, 403: 60 } },
  ];
  const refusedVerdicts = verdicts(refusedRows, { maxErrorRate: 0.01 });
  assert.equal(refusedVerdicts[0].ok, true);
  assert.equal(refusedVerdicts[1].ok, false);
  assert.match(refusedVerdicts[1].detail, /60 of 100/);
  const bad = verdicts([{ label: 'GET /a', count: 100, failed: 5 }], {
    lag: { count: 10, p95: 4000, max: 9000 },
    maxErrorRate: 0.01,
  });
  assert.equal(bad[0].ok, false);
  assert.equal(bad[2].ok, false);
  assert.match(bad[2].detail, /GENERATOR SATURATED/);
});

test('the table has a header, a ruler and one line per route', () => {
  const text = formatTable(
    [
      {
        label: 'GET /x',
        count: 3,
        perSecond: 1.5,
        mean: 12.34,
        p50: 12,
        p90: 13,
        p95: 14,
        p99: 15,
        max: 16,
        failed: 0,
        statuses: { 200: 3 },
      },
    ],
    { title: 'T' },
  );
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^route\s+count/);
  assert.match(lines[3], /^GET \/x\s+3\s+1\.5\s+12\.3/);
  assert.match(lines[3], /200:3$/);
});
