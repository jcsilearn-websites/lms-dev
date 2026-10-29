import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { declarationCount, type RouteDeclaration, registerRoutePolicy } from '../src/core/authz';
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
    } finally {
      await t.close();
    }
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
