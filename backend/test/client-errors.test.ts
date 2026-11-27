import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTelemetry, installTelemetry, type Telemetry } from '../src/core/telemetry';
import { makeApp, type TestApp } from './app';
import { createAuthFixture, testOwnerPool } from './support';

// Step 14b-2 part D: POST /api/client-errors, where the SPA's error boundary reports a crash. Public, a normal CSRF route (the SPA sends both headers), 4 KB,
// a closed shape, scrubbed again by the server, strictly rate limited, and no database access of its own.

let t: TestApp;
let telemetry: Telemetry;
let host: string;
const HEADERS = (h = 'localhost') => ({
  host: h,
  origin: `http://${h}`,
  'x-requested-with': 'lms',
  'content-type': 'application/json',
});

beforeAll(async () => {
  telemetry = createTelemetry({ serviceName: 'client-errors-test' });
  installTelemetry(telemetry);
  const owner = testOwnerPool(2);
  host = (await createAuthFixture(owner, 'cli-err')).host;
  await owner.end();
  t = makeApp({ logLevel: 'warn', env: { RATE_LIMIT_STORE: 'postgres' } });
  await t.app.ready();
});
afterAll(async () => {
  installTelemetry(null);
  await telemetry.shutdown();
  await t.close();
});

const send = (payload: unknown, headers: Record<string, string> = HEADERS()) =>
  t.app.inject({
    method: 'POST',
    url: '/api/client-errors',
    headers,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
const good = (over: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'render',
  message: 'boom',
  route: '/offerings/:id',
  build: 'b1',
  ...over,
});

describe('POST /api/client-errors', () => {
  it('accepts a report with 204, logs ONE scrubbed line and counts it by kind', async () => {
    t.logs.length = 0;
    const res = await send(
      good({
        kind: 'unhandled',
        message:
          'Failed for jane.doe@college.example.edu offering 0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07 token=SECRETVALUE register 2026123456',
        stack:
          'Error\n    at f (https://x-college.example.edu/assets/index-AbC.js:1:2?sid=COOKIEVALUE)',
        route: '/members/0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07/profile?email=jane@x.org',
      }),
    );
    expect(res.statusCode).toBe(204);
    const lines = t.logs.filter((l) => l.msg === 'client error');
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(text).not.toMatch(
      /jane|college\.example|0190a5c2|SECRETVALUE|COOKIEVALUE|2026123456|x-college/,
    );
    expect(text).toContain('[email]');
    expect(text).toContain('/members/:id/profile');
    expect(text).toContain('/assets/index-AbC.js:1:2');
    expect(await telemetry.renderMetrics()).toMatch(
      /lms_client_errors_total\{[^}]*kind="unhandled"[^}]*\} 1/,
    );
  });

  it('the server scrubs on its own: it does not trust a client that sent personal data', async () => {
    t.logs.length = 0;
    expect(
      (await send(good({ message: 'x@y.org 0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07' }))).statusCode,
    ).toBe(204);
    const text = JSON.stringify(t.logs.filter((l) => l.msg === 'client error'));
    expect(text).not.toMatch(/x@y\.org|0190a5c2/);
  });

  it('accepts only a closed shape: unknown fields, a wrong kind or version, missing message are 400', async () => {
    for (const bad of [
      good({ kind: 'weird' }),
      good({ v: 2 }),
      { v: 1, kind: 'render' },

      'not json',
      '[]',
      'null',
    ]) {
      const res = await send(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('an unknown field is dropped by the schema (the API strips what a route does not declare), never logged', async () => {
    t.logs.length = 0;
    expect((await send({ ...good(), extra: 'LEAKME', email: 'jane@x.org' })).statusCode).toBe(204);
    const text = JSON.stringify(t.logs.filter((l) => l.msg === 'client error'));
    expect(text).not.toMatch(/LEAKME|jane/);
  });

  it('refuses a body above 4 KB with the standard 413', async () => {
    const res = await send(
      good({ message: 'x'.repeat(1900), stack: 'y'.repeat(3900), route: 'z'.repeat(390) }),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBeDefined();
  });

  it('is public but a NORMAL CSRF route: without Origin and X-Requested-With it is refused (the exemption list stays at three)', async () => {
    const res = await send(good(), {
      host: 'localhost',
      'content-type': 'application/json',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
    expect((await t.app.inject({ method: 'GET', url: '/api/client-errors' })).statusCode).toBe(404);
  });

  it('works from a college host, signed in or not, and writes nothing: no statement of its own (the limiter has its own, one)', async () => {
    expect((await send(good(), HEADERS(host))).statusCode).toBe(204); // warms the college lookup (cached per instance)
    t.statements.reset();
    expect((await send(good(), HEADERS(host))).statusCode).toBe(204);
    expect(t.statements.limiter).toHaveLength(1);
    expect(t.statements.count).toBe(0);
  });

  it('is limited to 30 reports per address per minute (shared across API instances), then 429 with a standard body', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 35; i++)
      codes.push((await send(good({ message: `m${i}` }), HEADERS())).statusCode);
    expect(codes.filter((c) => c === 204).length).toBeLessThanOrEqual(30);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5);
    expect(codes.at(-1)).toBe(429);
  });
});
