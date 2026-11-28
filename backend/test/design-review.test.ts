import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStrictLimiter, type RateLimitStore } from '../src/core/rate-limit';
import { createTelemetry, installTelemetry, type Telemetry } from '../src/core/telemetry';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// The small gaps closed by the backend system design review (docs/system-design-review.md). Each test failed before its fix.

const TOKEN = 'metrics-test-token-0123456789abcdef0123';
let A: AuthFixture;
const apps: TestApp[] = [];
const app = (env: Record<string, string>) => {
  const t = makeApp({ env });
  apps.push(t);
  return t;
};
let telemetry: Telemetry;
let owner: ReturnType<typeof testOwnerPool>;

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'dr-a');
  telemetry = createTelemetry({ serviceName: 'lms-test', inMemorySpans: true });
  installTelemetry(telemetry);
});
afterAll(async () => {
  installTelemetry(null);
  await telemetry.shutdown();
  for (const a of apps) await a.close();
  await owner.end();
});

describe('behind a proxy: TRUST_PROXY_HOPS', () => {
  it('a client cannot escape a per-address limit by inventing X-Forwarded-For entries', async () => {
    const t = app({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '1' });
    await t.app.ready();
    const send = (forwarded: string) =>
      new TestClient(t, A.host).post(
        '/client-errors',
        {},
        { headers: { 'x-forwarded-for': forwarded } },
      );
    // the load balancer appends the real address on the RIGHT; everything left of it is the client's own claim
    let last = await send('198.51.100.1, 203.0.113.7');
    for (let i = 2; i <= 31; i++) last = await send(`198.51.100.${i}, 203.0.113.7`);
    expect(last.statusCode).toBe(429);
    // another real client is not affected
    expect((await send('198.51.100.1, 203.0.113.8')).statusCode).toBe(400);
  });

  it('with two hops (load balancer and front end) the address before them counts', async () => {
    const t = app({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' });
    await t.app.ready();
    const send = (forwarded: string) =>
      new TestClient(t, A.host).post(
        '/client-errors',
        {},
        { headers: { 'x-forwarded-for': forwarded } },
      );
    let last = await send('1.1.1.1, 203.0.113.9, 10.0.0.1');
    for (let i = 2; i <= 31; i++) last = await send(`1.1.1.${i}, 203.0.113.9, 10.0.0.1`);
    expect(last.statusCode).toBe(429);
  });
});

describe('the strict limiter when its store is slow', () => {
  it('stops waiting after its deadline and counts per instance instead', async () => {
    const stuck: RateLimitStore = { hit: () => new Promise(() => {}) };
    const errors: unknown[] = [];
    const limiter = createStrictLimiter({
      shared: stuck,
      timeoutMs: 50,
      onError: (err) => errors.push(err),
    });
    expect((await limiter.hit('k', 60_000)).count).toBe(1);
    expect((await limiter.hit('k', 60_000)).count).toBe(2);
    expect(errors).toHaveLength(2);
  }, 3000);
});

describe('429 answers', () => {
  it('the forged-cookie limit says when to come back, and every 429 is counted by route', async () => {
    const t = app({ RATE_LIMIT_MAX: '120', METRICS_TOKEN: TOKEN });
    await t.app.ready();
    const forged = (n: number) =>
      new TestClient(t, A.host).get('/members', {
        headers: { cookie: `sid=${String(n).padStart(43, 'a')}` },
      });
    let last = await forged(0);
    for (let n = 1; n <= 60; n++) last = await forged(n);
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe('rate_limited');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);

    const metrics = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}`, host: 'localhost' },
    });
    expect(metrics.body).toMatch(/lms_http_rate_limited_total\{[^}]*route="\/api\/members"/);
  });
});
