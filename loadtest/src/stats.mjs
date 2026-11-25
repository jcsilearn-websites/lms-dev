// Statistics of a load run: exact percentiles (nearest rank) over the recorded samples, bounded memory by reservoir sampling, per-label status
// counts, and a text table. Plain data in, plain data out: unit-tested without a server (test/stats.test.mjs).

import { mulberry32 } from './schedule.mjs';

/** Nearest-rank percentile of an ASCENDING array: the smallest value with at least p percent of the samples at or below it. */
export function percentileOfSorted(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Latency samples in milliseconds. Up to `maxSamples` are kept exactly; beyond that a seeded reservoir keeps a uniform sample (the count, mean,
 * min and max stay exact), so a long run cannot grow without bound and the same seed reproduces the same percentiles.
 */
export class Histogram {
  constructor(maxSamples = 200_000, seed = 1) {
    this.maxSamples = maxSamples;
    this.rng = mulberry32(seed);
    this.samples = [];
    this.count = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }

  record(ms) {
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(ms);
      return;
    }
    const j = Math.floor(this.rng() * this.count);
    if (j < this.maxSamples) this.samples[j] = ms;
  }

  percentiles(ps = [50, 90, 95, 99]) {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return Object.fromEntries(ps.map((p) => [`p${p}`, percentileOfSorted(sorted, p)]));
  }

  snapshot() {
    if (this.count === 0) return { count: 0 };
    return {
      count: this.count,
      mean: this.sum / this.count,
      min: this.min,
      max: this.max,
      ...this.percentiles(),
      sampled: this.count > this.samples.length,
    };
  }
}

/** One label per route template: latency, status codes, transport errors and bytes. */
export class Recorder {
  constructor({ maxSamples = 200_000, seed = 1 } = {}) {
    this.maxSamples = maxSamples;
    this.seed = seed;
    this.labels = new Map();
    this.startedAt = performance.now();
  }

  #entry(label) {
    let e = this.labels.get(label);
    if (!e) {
      e = {
        hist: new Histogram(this.maxSamples, this.seed + this.labels.size),
        statuses: new Map(),
        errors: new Map(),
        bytes: 0,
      };
      this.labels.set(label, e);
    }
    return e;
  }

  /** `status` 0 with an `error` code means the request never got an answer (reset, timeout, refused). */
  record(label, ms, status, { error, bytes = 0 } = {}) {
    const e = this.#entry(label);
    e.hist.record(ms);
    e.bytes += bytes;
    if (error) e.errors.set(error, (e.errors.get(error) ?? 0) + 1);
    e.statuses.set(status, (e.statuses.get(status) ?? 0) + 1);
  }

  /** A value that is not a request (schedule lag, an attempt's end-to-end time): same bookkeeping, status 200. */
  value(label, ms) {
    this.record(label, ms, 200);
  }

  elapsedSeconds() {
    return (performance.now() - this.startedAt) / 1000;
  }

  summary() {
    const seconds = Math.max(0.001, this.elapsedSeconds());
    return [...this.labels.entries()]
      .map(([label, e]) => {
        const statuses = Object.fromEntries([...e.statuses.entries()].sort((a, b) => a[0] - b[0]));
        const failed = [...e.statuses.entries()]
          .filter(([s]) => s === 0 || s >= 500)
          .reduce((n, [, c]) => n + c, 0);
        // answers that mean "you may not": a refused sign-in or token (401, 403) or a rate limit (429). Not server errors, but a load run that
        // is mostly refused measured nothing: the first video run had 1,337 of 2,137 segment requests refused and still looked fine
        const refused = [...e.statuses.entries()]
          .filter(([s]) => s === 401 || s === 403 || s === 429)
          .reduce((n, [, c]) => n + c, 0);
        return {
          label,
          ...e.hist.snapshot(),
          perSecond: e.hist.count / seconds,
          statuses,
          failed,
          refused,
          errors: Object.fromEntries(e.errors),
          bytes: e.bytes,
        };
      })
      .sort((a, b) => b.count - a.count);
  }
}

const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** A fixed-width table of a summary (what the console shows; the JSON file holds the same numbers). */
export function formatTable(rows, { title } = {}) {
  const head = [
    'route',
    'count',
    '/s',
    'mean',
    'p50',
    'p90',
    'p95',
    'p99',
    'max',
    'fail',
    'statuses',
  ];
  const body = rows.map((r) => [
    r.label,
    String(r.count),
    String(round(r.perSecond ?? 0, 1)),
    String(round(r.mean, 1)),
    String(round(r.p50, 1)),
    String(round(r.p90, 1)),
    String(round(r.p95, 1)),
    String(round(r.p99, 1)),
    String(round(r.max, 1)),
    String(r.failed ?? 0),
    Object.entries(r.statuses ?? {})
      .map(([s, c]) => `${s}:${c}`)
      .join(' '),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) =>
    cells
      .map((c, i) =>
        i === 0 ? c.padEnd(widths[i]) : i === cells.length - 1 ? c : c.padStart(widths[i]),
      )
      .join('  ');
  return [
    ...(title ? [title] : []),
    line(head),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
  ].join('\n');
}

/** The one-line verdicts of a run: error rate, and whether the GENERATOR kept up (a saturated generator makes the server look better than it is). */
export function verdicts(
  rows,
  { lag, maxErrorRate = 0.01, maxLagP95Ms = 1000, ignoreLabels = [] } = {},
) {
  const counted = rows.filter((r) => !ignoreLabels.includes(r.label) && !r.label.startsWith('~'));
  const total = counted.reduce((n, r) => n + r.count, 0);
  const failed = counted.reduce((n, r) => n + (r.failed ?? 0), 0);
  const rate = total === 0 ? 0 : failed / total;
  const refused = counted.reduce((n, r) => n + (r.refused ?? 0), 0);
  const refusedRate = total === 0 ? 0 : refused / total;
  const out = [
    {
      name: 'server errors and transport failures',
      ok: rate <= maxErrorRate,
      detail: `${failed} of ${total} (${round(rate * 100, 2)} %, limit ${round(maxErrorRate * 100, 2)} %)`,
    },
    {
      name: 'requests refused (401, 403, 429)',
      ok: refusedRate <= maxErrorRate,
      detail: `${refused} of ${total} (${round(refusedRate * 100, 2)} %, limit ${round(maxErrorRate * 100, 2)} %)${refused > 0 ? ': the load was refused, not served; a 429 means a rate limit needs raising for the test (docs/load-testing.md)' : ''}`,
    },
  ];
  if (lag && lag.count > 0) {
    out.push({
      name: 'load generator kept its schedule',
      ok: lag.p95 <= maxLagP95Ms,
      detail: `start lag p95 ${round(lag.p95, 0)} ms, max ${round(lag.max, 0)} ms (limit p95 ${maxLagP95Ms} ms)${lag.p95 > maxLagP95Ms ? ': GENERATOR SATURATED, run the load from a stronger or a second machine' : ''}`,
    });
  }
  return out;
}
