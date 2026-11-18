import { performance } from 'node:perf_hooks';
import autocannon from 'autocannon';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createBatchedLimiter, createMemoryRateLimitStore } from '../src/core/rate-limit';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { createRateLimitRepository, createRateLimitService } from '../src/modules/ratelimit';

// What the shared rate limiter costs (step 14a, docs/adr/0022, docs/benchmarks.md). Needs a MIGRATED database that has migration 0054
// (DATABASE_APP_URL = lms_app, DATABASE_URL = the owner, to clean up). It only writes rows keyed `bench-rl-*` in lms.rate_limit_counters
// and deletes them at the end, but point it at a TEST database, not at one with real traffic.
//
//   pnpm --filter @lms/backend run bench:ratelimit
//
// 1. the STORE itself: memory vs PostgreSQL, one call at a time and 16 at once (latency percentiles, calls per second)
// 2. the LOCAL tier: what a hit costs (no database, batched sync in the background)
// 3. HTTP, end to end: a route that only the local tier touches (a 404), and the strict-tier route (POST /api/csp-report),
//    with the memory store and with the PostgreSQL store

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} ms` : `${n.toFixed(0)} us`);

async function timeCalls(n: number, concurrency: number, call: (i: number) => Promise<unknown>) {
  const lat: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        const t0 = performance.now();
        await call(i);
        lat.push((performance.now() - t0) * 1000);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  return {
    perSecond: Math.round(n / seconds),
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    p99: pct(lat, 99),
  };
}

async function http(
  url: string,
  method: 'GET' | 'POST',
  body?: string,
  headers: Record<string, string> = {},
) {
  const r = await autocannon({
    url,
    method,
    connections: 16,
    duration: 6,
    ...(body ? { body } : {}),
    headers,
  });
  return {
    reqPerSec: Math.round(r.requests.average),
    p50: r.latency.p50,
    p99: r.latency.p99,
    non2xx: r.non2xx,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL (the owner connection) is needed to clean up');
  const env = parseApiEnv({
    ...process.env,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '100000000',
    RATE_LIMIT_STORE: 'postgres',
  });
  const owner = new pg.Client(connectionConfig(ownerUrl, env.DB_SSL, env.DB_SSL_CA));
  await owner.connect();
  const db = createDb({
    url: env.DATABASE_APP_URL,
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    max: 10,
    applicationName: 'lms-bench-rl',
  });
  const service = createRateLimitService({ db, rateLimitRepo: createRateLimitRepository() });
  const out: string[] = [];
  try {
    // ---- 1. the stores
    const memory = createMemoryRateLimitStore();
    const N = 4000;
    for (const [label, store] of [
      ['memory', memory],
      ['postgres', service.store],
    ] as const) {
      for (const c of [1, 16]) {
        const r = await timeCalls(N, c, (i) => store.hit(`bench-rl-${label}-${i % 50}`, 60_000, 1));
        out.push(
          `store ${label.padEnd(8)} concurrency ${String(c).padStart(2)}: ${String(r.perSecond).padStart(7)} calls/s  p50 ${fmt(r.p50)}  p95 ${fmt(r.p95)}  p99 ${fmt(r.p99)}`,
        );
      }
    }
    // a hot key (every call hits the SAME row: the worst case for row locking)
    const hot = await timeCalls(N, 16, () => service.store.hit('bench-rl-hot', 60_000, 1));
    out.push(
      `store postgres HOT KEY, 16 at once: ${hot.perSecond} calls/s  p50 ${fmt(hot.p50)}  p99 ${fmt(hot.p99)}`,
    );

    // ---- 2. the local tier
    const limiter = createBatchedLimiter({ shared: service.store });
    const hits = 500_000;
    const t0 = performance.now();
    for (let i = 0; i < hits; i++) limiter.hit(`bench-rl-local-${i % 200}`, 60_000, 600);
    const ns = ((performance.now() - t0) * 1e6) / hits;
    out.push(
      `local tier: ${ns.toFixed(0)} ns per hit over 200 keys (sync decision, batched background sync)`,
    );

    // ---- 3. HTTP
    for (const store of ['memory', 'postgres'] as const) {
      const e = parseApiEnv({
        ...process.env,
        LOG_LEVEL: 'silent',
        RATE_LIMIT_MAX: '100000000',
        RATE_LIMIT_STORE: store,
      });
      const appDb = createDb({
        url: e.DATABASE_APP_URL,
        ssl: e.DB_SSL,
        sslCa: e.DB_SSL_CA,
        max: 10,
        applicationName: 'lms-bench-rl-http',
      });
      const app = buildApp({ env: e, db: appDb, logger: createLogger(e) });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const local = await http(`${base}/api/does-not-exist`, 'GET');
      const strict = await http(`${base}/api/csp-report`, 'POST', '{}', {
        'content-type': 'application/csp-report',
      });
      out.push(
        `HTTP ${store.padEnd(8)} local tier (404 route)      : ${local.reqPerSec} req/s  p50 ${local.p50} ms  p99 ${local.p99} ms`,
      );
      out.push(
        `HTTP ${store.padEnd(8)} strict tier (POST csp-report): ${strict.reqPerSec} req/s  p50 ${strict.p50} ms  p99 ${strict.p99} ms  (non-2xx: ${strict.non2xx}, 429 after the 60/min limit)`,
      );
      await app.close();
      await appDb.close();
    }
  } finally {
    await owner
      .query("DELETE FROM lms.rate_limit_counters WHERE key LIKE '%bench-rl-%'")
      .catch(() => {});
    await owner.end();
    await db.close();
  }
  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
