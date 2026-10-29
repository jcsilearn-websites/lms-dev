import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';

// The API lives under /api. These tests use raw requests (not TestClient, which adds the prefix for
// the other tests) so the URLs are exactly what a gateway sends.
let t: TestApp;
beforeAll(async () => {
  t = makeApp();
  await t.app.ready();
});
afterAll(() => t.close());

const get = (url: string, host = 'localhost') =>
  t.app.inject({ method: 'GET', url, headers: { host } });

describe('/api prefix', () => {
  it('serves the health probes at the root AND under /api', async () => {
    for (const url of ['/health/live', '/api/health/live', '/health/ready', '/api/health/ready']) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
  });

  it('does not serve application routes without the prefix (they belong to the SPA)', async () => {
    for (const url of ['/auth/me', '/members', '/audit', '/imports', '/tenant/info']) {
      expect((await get(url, 'some-college.localhost')).statusCode, url).toBe(404);
    }
  });

  it('serves them under /api: the route exists (an unknown college is 404 tenant_not_found, not "route not found")', async () => {
    const res = await get('/api/tenant/info', 'some-college.localhost');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('tenant_not_found');
  });

  it('the OpenAPI docs stay at /docs', async () => {
    expect((await get('/docs/json')).statusCode).toBe(200);
  });
});
