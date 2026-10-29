import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from '../../../test/app';
import { AppError } from '../errors';
import { bindTenantToLog } from '../tenant-log';
import { newId } from '../uuid';

const LEAKY = 'secret-internal-detail SELECT * FROM lms.users password=hunter2';

let t: TestApp;

beforeAll(async () => {
  t = makeApp({ env: { BODY_LIMIT_BYTES: '2048', RATE_LIMIT_MAX: '1000' }, logLevel: 'info' });
  const { app, db } = t;
  app.get('/t/boom', { config: { public: true } }, async () => {
    throw new Error(LEAKY);
  });
  app.get('/t/sql-error', { config: { public: true } }, async () =>
    // a REAL database error (missing relation) must not reach the client
    db.withTenant(newId(), (tx) => tx.execute(sql`select * from lms.table_that_does_not_exist`)),
  );
  app.get('/t/app-error', { config: { public: true } }, async () => {
    throw new AppError(409, 'conflict', 'Already exists');
  });
  app.get(
    '/t/validated',
    {
      config: { public: true },
      schema: { querystring: Type.Object({ n: Type.Integer({ minimum: 1 }) }) },
    },
    async () => ({ ok: true }),
  );
  app.post('/t/echo', { config: { public: true } }, async () => ({ ok: true }));
  app.get('/t/tenant', { config: { public: true } }, async (request) => {
    bindTenantToLog(request, '0190aaaa-0000-7000-8000-000000000001');
    request.log.info({ password: 'hunter2', token: 'abc' }, 'tenant-scoped line');
    return { ok: true };
  });
  await app.ready();
});

afterAll(async () => {
  await t.close();
});

const errorShape = (body: unknown) => {
  expect(body).toEqual({
    error: {
      code: expect.any(String),
      message: expect.any(String),
      requestId: expect.any(String),
      ...((body as { error: { details?: unknown } }).error.details
        ? { details: expect.any(Array) }
        : {}),
    },
  });
};

// State-changing requests need the CSRF headers (nothing is exempt), otherwise they never reach the handler.
const BROWSER = { host: 'localhost', origin: 'http://localhost', 'x-requested-with': 'lms' };

describe('error handler', () => {
  it('returns a consistent shape and hides internals for unexpected errors', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/t/boom' });
    expect(res.statusCode).toBe(500);
    errorShape(res.json());
    expect(res.json().error.code).toBe('internal_error');
    expect(res.body).not.toMatch(/hunter2|SELECT|secret-internal|stack|\.ts:\d+/i);
    // ...but the detail IS logged server-side
    expect(JSON.stringify(t.logs)).toContain('secret-internal-detail');
  });

  it('does not leak SQL errors from the database', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/t/sql-error' });
    expect(res.statusCode).toBe(500);
    errorShape(res.json());
    expect(res.body).not.toMatch(/table_that_does_not_exist|relation|lms\.|42P01|select/i);
  });

  it('maps AppError to its status, code and message', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/t/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'conflict', message: 'Already exists' });
  });

  it('returns 400 validation_error with details for bad input', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/t/validated?n=0' });
    expect(res.statusCode).toBe(400);
    errorShape(res.json());
    expect(res.json().error.code).toBe('validation_error');
    expect(res.json().error.details[0]).toMatchObject({ path: '/n' });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    errorShape(res.json());
    expect(res.json().error.code).toBe('not_found');
  });

  it('enforces the body size limit with 413', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: BROWSER,
      payload: { blob: 'x'.repeat(4096) },
    });
    expect(res.statusCode).toBe(413);
    errorShape(res.json());
    expect(res.json().error.code).toBe('payload_too_large');
  });

  it('rejects state-changing requests without CSRF headers before they reach the handler', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/t/echo', payload: { a: 1 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });

  it('returns 400 (not 500) for malformed JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { ...BROWSER, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    errorShape(res.json());
  });
});

describe('request id and logging', () => {
  it('sets x-request-id and echoes it in error bodies', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.json().error.requestId).toBe(res.headers['x-request-id']);
  });

  it('honours a well-formed incoming x-request-id and rejects unsafe ones', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'trace-abc_123' },
    });
    expect(ok.headers['x-request-id']).toBe('trace-abc_123');
    const bad = await t.app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'bad id with spaces <script>' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs request_id, tenant_id once bound, and redacts sensitive fields', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/t/tenant?token=querysecret' });
    const line = t.logs.find((l) => l.msg === 'tenant-scoped line');
    expect(line).toBeDefined();
    expect(line?.request_id).toBe(res.headers['x-request-id']);
    expect(line?.tenant_id).toBe('0190aaaa-0000-7000-8000-000000000001');
    expect(line?.password).toBe('[redacted]');
    expect(line?.token).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('hunter2');
    // query strings are never logged
    expect(JSON.stringify(t.logs)).not.toContain('querysecret');
  });
});

describe('security plugins', () => {
  it('sends helmet security headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS allows only configured origins', async () => {
    const cors = makeApp({ env: { CORS_ORIGINS: 'https://app.example.com' } });
    try {
      const allowed = await cors.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://app.example.com' },
      });
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
      const denied = await cors.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it('rate limits with the standard error shape', async () => {
    const rl = makeApp({ env: { RATE_LIMIT_MAX: '2' } });
    try {
      await rl.app.inject({ method: 'GET', url: '/nope' });
      await rl.app.inject({ method: 'GET', url: '/nope' });
      const res = await rl.app.inject({ method: 'GET', url: '/nope' });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('rate_limited');
    } finally {
      await rl.close();
    }
  });
});

describe('OpenAPI docs', () => {
  it('are served outside production', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths).toHaveProperty('/health/live');
  });

  it('are NOT served in production', async () => {
    const prod = makeApp({ env: { NODE_ENV: 'production' } });
    try {
      expect((await prod.app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
      expect((await prod.app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });
});
