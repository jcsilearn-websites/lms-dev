import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteDeclaration } from '../src/core/authz';
import { makeApp, type TestApp } from './app';

// WHICH ROUTES ASK FOR A STEP-UP (docs/adr/0026-mfa.md). The list is pinned: a listed route that loses its flag fails here, and
// so does a NEW platform write that was added without it. Read from the real app's route table.

const STEP_UP_ROUTES = [
  // members of a college
  'PATCH /api/members/:userId/role',
  'POST /api/members/:userId/suspend',
  'POST /api/members/:userId/reactivate',
  'DELETE /api/members/:userId',
  'POST /api/auth/members/:userId/unlock',
  // conditional: only when the invited role is institution_admin (step-up.test.ts)
  'POST /api/auth/invites',
  // erasure decisions
  'POST /api/privacy/erasure-requests/:id/approve',
  'POST /api/privacy/erasure-requests/:id/reject',
  'POST /api/privacy/erasure-requests/:id/cancel',
  // an approved gradebook
  'POST /api/offerings/:id/gradebook/unlock',
  // the person's own sign-in
  'POST /api/auth/password/change',
  'POST /api/me/mfa/replace/start',
  'POST /api/me/mfa/replace/confirm',
  'POST /api/me/mfa/recovery-codes',
  'POST /api/me/mfa/disable',
  // every platform write, and the audited platform view of a college's members
  'POST /api/platform/tenants',
  'PATCH /api/platform/tenants/:id',
  'POST /api/platform/tenants/:id/suspend',
  'POST /api/platform/tenants/:id/reactivate',
  'POST /api/platform/tenants/:id/admin-invite',
  'GET /api/platform/tenants/:id/members',
  'PUT /api/platform/tenants/:id/email-sender',
  'DELETE /api/platform/email/suppressions/:id',
  'POST /api/platform/account-erasures',
  'POST /api/platform/account-erasures/:id/approve',
  'POST /api/platform/account-erasures/:id/reject',
  'POST /api/platform/account-erasures/:id/cancel',
  'POST /api/platform/mfa-resets',
  'POST /api/platform/mfa-resets/:id/approve',
  'POST /api/platform/mfa-resets/:id/reject',
  'POST /api/platform/mfa-resets/:id/cancel',
];

/** Platform writes that deliberately ask for none, each with its reason. */
const EXEMPT_PLATFORM_WRITES: Record<string, string> = {
  'POST /api/platform/notifications/read': "marks the caller's OWN notices as read",
};

interface Seen {
  key: string;
  method: string;
  url: string;
  config: RouteDeclaration;
}

const isPlatformWrite = (r: Seen) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) return false;
  const p = r.config.permission;
  const names = p === undefined ? [] : typeof p === 'string' ? [p] : [...p];
  return r.url.startsWith('/api/platform/') || names.some((n) => n.startsWith('platform.'));
};

/** The platform writes that lack the flag and are not exempt. */
const unprotected = (routes: Seen[]) =>
  routes
    .filter(
      (r) =>
        isPlatformWrite(r) && r.config.stepUp === undefined && !(r.key in EXEMPT_PLATFORM_WRITES),
    )
    .map((r) => r.key);

let t: TestApp;
const routes: Seen[] = [];

beforeAll(async () => {
  t = makeApp();
  t.app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat().map(String)) {
      if (method === 'HEAD') continue;
      routes.push({
        key: `${method} ${route.url}`,
        method,
        url: route.url,
        config: (route.config ?? {}) as RouteDeclaration,
      });
    }
  });
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
});

describe('step-up routes', () => {
  it('are exactly the pinned list', () => {
    const flagged = routes.filter((r) => r.config.stepUp !== undefined).map((r) => r.key);
    expect([...flagged].sort()).toEqual([...STEP_UP_ROUTES].sort());
  });

  it('only the invite is conditional', () => {
    expect(
      routes
        .filter((r) => r.config.stepUp !== undefined && r.config.stepUp !== true)
        .map((r) => r.key),
    ).toEqual(['POST /api/auth/invites']);
  });

  it('no platform write is without one (and the exemptions still exist)', () => {
    expect(routes.filter(isPlatformWrite).length).toBeGreaterThan(10);
    expect(unprotected(routes)).toEqual([]);
    for (const key of Object.keys(EXEMPT_PLATFORM_WRITES)) {
      expect(routes.map((r) => r.key)).toContain(key);
    }
  });

  it('the rule catches a new platform write that was added without it', () => {
    const added: Seen[] = [
      {
        key: 'POST /api/platform/anything',
        method: 'POST',
        url: '/api/platform/anything',
        config: { permission: 'platform.tenant.manage' },
      },
      {
        key: 'DELETE /api/elsewhere/:id',
        method: 'DELETE',
        url: '/api/elsewhere/:id',
        config: { permission: ['member.unlock', 'platform.user.unlock'] },
      },
    ];
    expect(unprotected([...routes, ...added])).toEqual(added.map((r) => r.key));
  });

  it('a public route cannot declare one', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerRoutePolicy } = await import('../src/core/authz');
    const app = Fastify();
    registerRoutePolicy(app);
    expect(() =>
      app.post('/x', { config: { public: true, stepUp: true } }, async () => 'x'),
    ).toThrow(/cannot step up/);
    await app.close();
  });
});
