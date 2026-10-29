import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from '../../../../test/app';
import { createDb } from '../../../db/client';

describe('health endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = makeApp();
    await t.app.ready();
  });
  afterAll(async () => {
    await t.close();
  });

  it('GET /health/live returns ok without touching the DB', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/live stays up even when the database is unreachable', async () => {
    const dead = makeApp({
      db: createDb({
        url: 'postgresql://lms_app:x@127.0.0.1:1/postgres',
        ssl: 'off',
        max: 1,
        connectionTimeoutMs: 500,
        applicationName: 'lms-test-dead',
      }),
    });
    try {
      const res = await dead.app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
    } finally {
      await dead.close();
    }
  });

  it('GET /health/ready returns ok when the DB is reachable', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up' });
  });

  it('GET /health/ready fails with 503 when the DB is unreachable, without leaking details', async () => {
    const dead = makeApp({
      db: createDb({
        url: 'postgresql://lms_app:secretpw@127.0.0.1:1/postgres',
        ssl: 'off',
        max: 1,
        connectionTimeoutMs: 500,
        applicationName: 'lms-test-dead',
      }),
      env: { READY_TIMEOUT_MS: '3000' },
    });
    try {
      const res = await dead.app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error.code).toBe('not_ready');
      expect(body.error.requestId).toBe(res.headers['x-request-id']);
      expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|secretpw|postgres/i);
    } finally {
      await dead.close();
    }
  });

  it('health probes are exempt from rate limiting', async () => {
    const limited = makeApp({ env: { RATE_LIMIT_MAX: '1' } });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await limited.app.inject({ method: 'GET', url: '/health/live' });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });
});
