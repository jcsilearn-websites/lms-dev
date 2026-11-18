import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { declarationCount, type RouteDeclaration, registerRoutePolicy } from '../src/core/authz';
import { CSRF_EXEMPT_ROUTES, registerCsrf } from '../src/core/csrf';
import { registerErrorHandling } from '../src/core/error-handler';
import { makeApp } from './app';

// Every registered route must declare exactly one of config.permission / config.authenticated /
// config.public. The app refuses to boot otherwise (registerRoutePolicy); this test re-checks the
// real route table independently and proves the startup hook itself works.
describe('route declarations', () => {
  it('every route of the real app declares exactly one authorization kind', async () => {
    const t = makeApp();
    const seen: { route: string; kinds: number }[] = [];
    t.app.addHook('onRoute', (route) => {
      if (route.url.startsWith('/docs') || route.schema?.hide === true) return;
      seen.push({
        route: `${String(route.method)} ${route.url}`,
        kinds: declarationCount(route.config as RouteDeclaration | undefined),
      });
    });
    try {
      await t.app.ready();
      expect(seen.length).toBeGreaterThan(10);
      expect(seen.filter((r) => r.kinds !== 1)).toEqual([]);
      // every route is under /api (or is a health probe, which is also served at the root, or the metrics scrape target)
      expect(
        seen.filter((r) => !/^\w+ \/(api\/|health\/|metrics$)/.test(r.route)).map((r) => r.route),
      ).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('exactly three routes are CSRF-exempt (RFC 8058 one-click, the signed provider webhook, the browser CSP report), all public', async () => {
    expect(CSRF_EXEMPT_ROUTES).toEqual({
      'POST /api/notifications/unsubscribe/one-click': 'rfc8058-one-click',
      'POST /api/email/webhooks/:provider': 'signed-webhook',
      'POST /api/csp-report': 'csp-report',
    });
    const t = makeApp();
    const exempt: { route: string; reason: unknown; isPublic: boolean }[] = [];
    t.app.addHook('onRoute', (route) => {
      const config = route.config as { csrfExempt?: unknown; public?: boolean } | undefined;
      if (config?.csrfExempt !== undefined) {
        exempt.push({
          route: `${String(route.method)} ${route.url}`,
          reason: config.csrfExempt,
          isPublic: config.public === true,
        });
      }
    });
    try {
      await t.app.ready();
      expect(exempt).toEqual([
        {
          route: 'POST /api/notifications/unsubscribe/one-click',
          reason: 'rfc8058-one-click',
          isPublic: true,
        },
        { route: 'POST /api/email/webhooks/:provider', reason: 'signed-webhook', isPublic: true },
        { route: 'POST /api/csp-report', reason: 'csp-report', isPublic: true },
      ]);
    } finally {
      await t.close();
    }
  });

  it('a csrfExempt declaration on a route NOT in the list is ignored (the CSRF check still runs)', async () => {
    const app = Fastify();
    registerErrorHandling(app);
    registerCsrf(app);
    app.post('/api/elsewhere', { config: { csrfExempt: 'signed-webhook' } }, async () => 'x');
    const res = await app.inject({ method: 'POST', url: '/api/elsewhere' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('refuses to register a route without a declaration or with two', async () => {
    const app = Fastify();
    registerRoutePolicy(app);
    expect(() => app.get('/x', async () => 'x')).toThrow(/must declare exactly one/);
    expect(() =>
      app.get('/y', { config: { public: true, authenticated: true } }, async () => 'y'),
    ).toThrow(/must declare exactly one/);
    app.get('/z', { config: { public: true } }, async () => 'z');
    await app.close();
  });
});
