import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHealthServer } from '../src/core/health-server';
import { createTelemetry, installTelemetry, type Telemetry } from '../src/core/telemetry';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// Step 14a: traces (HTTP -> service -> database), metrics (latency by route, errors, pool, queue depth and age, outbox backlog,
// rollup lag, video backlog), the protected /metrics endpoint and the worker's health port.

const TOKEN = 'metrics-test-token-0123456789abcdef0123';
let owner: pg.Pool;
let A: AuthFixture;
let telemetry: Telemetry;
let t: TestApp;
const apps: TestApp[] = [];

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'obs-a');
  telemetry = createTelemetry({ serviceName: 'lms-test', inMemorySpans: true });
  installTelemetry(telemetry);
  t = makeApp({ env: { METRICS_TOKEN: TOKEN } });
  apps.push(t);
  t.app.modules.ops.service.registerGauges(telemetry);
  await t.app.ready();
});
afterAll(async () => {
  installTelemetry(null);
  await telemetry.shutdown();
  for (const a of apps) await a.close();
  await owner.end();
});

describe('traces', () => {
  it('a request is one trace: the HTTP span, the service call below it and the database transaction below that', async () => {
    const c = new TestClient(t, A.host);
    expect((await c.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
    await telemetry.forceFlush();
    const before = telemetry.getSpans().length;
    const res = await c.get('/members');
    expect(res.statusCode).toBe(200);
    await telemetry.forceFlush();
    const spans = telemetry.getSpans().slice(before);
    const http = spans.find((s) => s.name === 'HTTP GET /api/members');
    expect(http, spans.map((s) => s.name).join(', ')).toBeDefined();
    expect(http?.attributes['http.route']).toBe('/api/members');
    expect(http?.attributes['http.response.status_code']).toBe(200);
    const inTrace = spans.filter((s) => s.spanContext().traceId === http?.spanContext().traceId);
    const service = inTrace.find((s) => /^memberships\./.test(s.name));
    expect(service, inTrace.map((s) => s.name).join(', ')).toBeDefined();
    const tx = inTrace.find((s) => s.name === 'db.transaction');
    expect(tx).toBeDefined();
    // the chain: HTTP -> service -> db.transaction
    expect(service?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId);
    expect(tx?.parentSpanContext?.spanId).toBe(service?.spanContext().spanId);
  });

  it('no span carries an email address, a token or a password', async () => {
    const all = JSON.stringify(telemetry.getSpans().map((s) => ({ n: s.name, a: s.attributes })));
    expect(all).not.toContain(A.adminEmail);
    expect(all).not.toContain(TEST_PASSWORD);
    expect(all).not.toMatch(/sid=|Bearer /);
  });
});

describe('metrics', () => {
  it('records latency and requests by ROUTE TEMPLATE (never the raw url) and the pool', async () => {
    const c = new TestClient(t, A.host);
    await c.login(A.adminEmail, TEST_PASSWORD);
    await c.get('/members');
    await c.get('/members/00000000-0000-7000-8000-000000000001'); // a 404 on a templated route
    const text = await telemetry.renderMetrics();
    expect(text).toMatch(
      /lms_http_requests_total\{[^}]*route="\/api\/members"[^}]*status_class="2xx"/,
    );
    expect(text).toMatch(
      /lms_http_requests_total\{[^}]*route="\/api\/members\/:userId"[^}]*status_class="4xx"/,
    );
    expect(text).toContain('lms_http_request_duration_seconds_bucket');
    expect(text).not.toContain('00000000-0000-7000-8000-000000000001'); // ids never become labels
    expect(text).toMatch(/lms_db_pool_connections\{[^}]*state="total"/);
    expect(text).toMatch(/lms_db_pool_connections\{[^}]*state="waiting"/);
  });

  it('exposes queue depth and oldest age per queue, the email backlog, rollup lag and the video backlog', async () => {
    await owner.query(
      `INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at)
       VALUES (lms.uuid_v7(), 'obs.test', NULL, '{}'::jsonb, now() - interval '90 seconds')`,
    );
    // a fresh service instance: the ops service caches for 5 s
    const text = await (async () => {
      const fresh = makeApp({ env: { METRICS_TOKEN: TOKEN } });
      apps.push(fresh);
      const tel = createTelemetry({ serviceName: 'x' });
      fresh.app.modules.ops.service.registerGauges(tel);
      return tel.renderMetrics();
    })();
    expect(text).toMatch(/lms_job_queue_depth\{[^}]*queue="obs.test"[^}]*\} 1/);
    const age = /lms_job_queue_oldest_age_seconds\{[^}]*queue="obs.test"[^}]*\} ([0-9.]+)/.exec(
      text,
    );
    expect(Number(age?.[1])).toBeGreaterThanOrEqual(89);
    for (const name of [
      'lms_email_outbox_oldest_age_seconds',
      'lms_email_outbox_dead',
      'lms_rollup_lag_seconds',
      'lms_video_oldest_age_seconds',
      'lms_video_backlog',
    ]) {
      expect(text, name).toContain(name);
    }
    await owner.query(`DELETE FROM lms.jobs WHERE queue = 'obs.test'`).catch(() => {});
  });

  it('counts every legacy-token verification (the metric that says when the legacy format can be switched off)', async () => {
    const { createPlaybackTokens } = await import('../src/core/video');
    const { createHmac } = await import('node:crypto');
    const secret = 'l'.repeat(40);
    const claims = {
      t: A.tenantId,
      a: A.tenantId,
      u: A.tenantId,
      e: Math.floor(Date.now() / 1000) + 600,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', secret)
      .update('lms.video.playback.v1')
      .update('.')
      .update(payload)
      .digest('base64url');
    expect(createPlaybackTokens(secret).verify(`${payload}.${mac}`)).toEqual(claims);
    expect(await telemetry.renderMetrics()).toMatch(
      /lms_legacy_token_verifications_total\{[^}]*purpose="playback"[^}]*\} [1-9]/,
    );
  });
});

describe('GET /metrics', () => {
  const get = (app: TestApp, auth?: string) =>
    app.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: auth ? { authorization: auth } : {},
    });

  it('needs the bearer token: 401 without or with a wrong one, 200 with the right one', async () => {
    expect((await get(t)).statusCode).toBe(401);
    expect((await get(t, 'Bearer wrong')).statusCode).toBe(401);
    expect((await get(t, `Basic ${TOKEN}`)).statusCode).toBe(401);
    const ok = await get(t, `Bearer ${TOKEN}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toContain('lms_http_requests_total');
  });

  it('costs at most ONE statement however often it is scraped (the gauges share one cached read)', async () => {
    await new Promise((r) => setTimeout(r, 5100)); // the ops service caches for 5 s
    t.statements.reset();
    for (let i = 0; i < 5; i++) expect((await get(t, `Bearer ${TOKEN}`)).statusCode).toBe(200);
    expect(t.statements.count).toBeLessThanOrEqual(1);
  });

  it('is DISABLED (404) when no token is configured, whatever header is sent', async () => {
    const off = makeApp();
    apps.push(off);
    expect((await get(off, `Bearer ${TOKEN}`)).statusCode).toBe(404);
    expect((await get(off)).statusCode).toBe(404);
  });

  it('is rate limited like a credential endpoint', async () => {
    const lim = makeApp({ env: { METRICS_TOKEN: TOKEN } });
    apps.push(lim);
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) codes.push((await get(lim, 'Bearer nope')).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 401)).toBe(true);
    expect(codes.slice(60).every((c) => c === 429)).toBe(true);
  });
});

describe('the worker health port', () => {
  it('serves liveness, readiness (503 when not ready) and protected metrics', async () => {
    let ready = true;
    const server = await startHealthServer({
      port: 0,
      host: '127.0.0.1',
      ready: async () => ({ ok: ready, details: { db: ready ? 'up' : 'down' } }),
      metricsToken: TOKEN,
      renderMetrics: () => telemetry.renderMetrics(),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      const r1 = await fetch(`${base}/health/ready`);
      expect(r1.status).toBe(200);
      expect(await r1.json()).toMatchObject({ status: 'ok', db: 'up' });
      ready = false;
      const r2 = await fetch(`${base}/health/ready`);
      expect(r2.status).toBe(503);
      expect(await r2.json()).toMatchObject({ status: 'unavailable', db: 'down' });
      expect((await fetch(`${base}/metrics`)).status).toBe(401);
      const m = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(m.status).toBe(200);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/health/live`, { method: 'POST' })).status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
