import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declarationCount, type RouteDeclaration } from '../src/core/authz';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// AUTHORIZATION MATRIX. Every endpoint x every kind of caller -> the expected status. This table is
// the specification of who may call what: read it as documentation.
//
// A session belongs to ONE host: a cookie issued by college B is ignored on college A, a tenant
// cookie is ignored on the admin host and a platform-admin cookie is ignored on a tenant host. So
// "institution admin of ANOTHER tenant" and "platform admin on a tenant host" arrive as ANONYMOUS
// (401); on the admin host the tenant users do too. A signed-in user who merely LACKS the permission
// gets 403.
//
// Mutating endpoints are called with an unknown member / tenant id (or an empty body): a caller who
// is allowed gets past authorization and then 404 / 400 / 200 without touching real data, a caller
// who is not is stopped BEFORE body validation (401 / 403, never a validation error).

const U = '00000000-0000-7000-8000-000000000000';

// callers on a tenant host:  anonymous | member | admin | admin of ANOTHER tenant | platform admin
// callers on the admin host: anonymous | tenant member | tenant admin | platform admin
type TenantCallers = [number, number, number, number, number];
type AdminCallers = [number, number, number, number];

interface Row {
  endpoint: string;
  method: string;
  url: string;
  body?: unknown;
  tenantHost: TenantCallers;
  adminHost: AdminCallers;
}

/** Endpoints guarded by a tenant permission (member.*, audit.read): `ok` is what an allowed admin gets. */
const tenantPerm = (method: string, url: string, ok: number, body?: unknown): Row => ({
  endpoint: `${method} ${url}`,
  method,
  url,
  body,
  tenantHost: [401, 403, ok, 401, 401],
  // on the admin host a platform admin has no tenant permission: 403
  adminHost: [401, 401, 401, 403],
});

/** Platform endpoints: only a platform admin on the admin host passes. */
const platformPerm = (method: string, url: string, ok: number, body?: unknown): Row => ({
  endpoint: `${method} ${url}`,
  method,
  url,
  body,
  tenantHost: [401, 403, 403, 401, 401],
  adminHost: [401, 401, 401, ok],
});

/** A tenant permission that EVERY active member has (academic.read, profile.read_own). */
const tenantRead = (method: string, url: string, ok: number, body?: unknown): Row => ({
  endpoint: `${method} ${url}`,
  method,
  url,
  body,
  tenantHost: [401, ok, ok, 401, 401],
  // on the admin host a platform admin has no tenant permission: 403
  adminHost: [401, 401, 401, 403],
});

/** Any signed-in user. */
const authenticated = (method: string, url: string, ok: number, body?: unknown): Row => ({
  endpoint: `${method} ${url}`,
  method,
  url,
  body,
  tenantHost: [401, ok, ok, 401, 401],
  adminHost: [401, 401, 401, ok],
});

const ROWS: Row[] = [
  // ---- tenant host, institution admin
  tenantPerm('GET', '/members', 200),
  tenantPerm('GET', `/members/${U}`, 404),
  tenantPerm('PATCH', `/members/${U}/role`, 400, {}),
  tenantPerm('POST', `/members/${U}/suspend`, 404),
  tenantPerm('POST', `/members/${U}/reactivate`, 404),
  tenantPerm('DELETE', `/members/${U}`, 404),
  tenantPerm('POST', `/members/${U}/resend-invite`, 404),
  tenantPerm('GET', '/audit', 200),
  tenantPerm('POST', '/auth/invites', 400, {}),
  // unlock: an institution admin on a tenant host, or a platform admin on the admin host
  {
    endpoint: `POST /auth/members/${U}/unlock`,
    method: 'POST',
    url: `/auth/members/${U}/unlock`,
    tenantHost: [401, 403, 404, 401, 401],
    adminHost: [401, 401, 401, 200],
  },
  // ---- academic structure: readable by every member, changed by the institution admin
  ...['academic-years', 'terms', 'departments', 'programs', 'batches', 'sections'].flatMap((e) => [
    tenantRead('GET', `/${e}`, 200),
    tenantRead('GET', `/${e}/${U}`, 404),
    tenantPerm('POST', `/${e}`, 400, {}),
    tenantPerm('PATCH', `/${e}/${U}`, 400, {}),
    tenantPerm('POST', `/${e}/${U}/archive`, 404),
    tenantPerm('POST', `/${e}/${U}/unarchive`, 404),
    tenantPerm('DELETE', `/${e}/${U}`, 404),
  ]),
  tenantPerm('POST', `/academic-years/${U}/set-current`, 404),
  // ---- member profiles: managed by the institution admin, own profile readable by every member
  tenantPerm('GET', `/members/${U}/profile`, 404),
  tenantPerm('PATCH', `/members/${U}/profile`, 400, {}),
  tenantPerm('POST', `/members/${U}/profile/section`, 400, {}),
  tenantPerm('POST', '/sections/move', 400, {}),
  tenantRead('GET', '/me/profile', 404),
  // ---- bulk import: institution admin only (import.run)
  tenantPerm('GET', '/imports/templates/students.csv', 200),
  tenantPerm('GET', '/imports/templates/faculty.csv', 200),
  tenantPerm('POST', '/imports', 400),
  tenantPerm('GET', '/imports', 200),
  tenantPerm('GET', `/imports/${U}`, 404),
  tenantPerm('GET', `/imports/${U}/rows`, 404),
  tenantPerm('GET', `/imports/${U}/errors.csv`, 404),
  tenantPerm('POST', `/imports/${U}/confirm`, 404, {}),
  tenantPerm('POST', `/imports/${U}/cancel`, 404),
  // ---- admin host, platform admin
  platformPerm('POST', '/platform/tenants', 400, {}),
  platformPerm('GET', '/platform/tenants', 200),
  platformPerm('GET', `/platform/tenants/${U}`, 404),
  platformPerm('PATCH', `/platform/tenants/${U}`, 404, { name: 'x' }),
  platformPerm('POST', `/platform/tenants/${U}/suspend`, 404),
  platformPerm('POST', `/platform/tenants/${U}/reactivate`, 404),
  platformPerm('POST', `/platform/tenants/${U}/admin-invite`, 404, {
    email: 'nobody@matrix.test',
    displayName: 'Nobody',
  }),
  platformPerm('GET', `/platform/tenants/${U}/members`, 404),
  platformPerm('GET', '/platform/audit', 200),
  // ---- any signed-in user
  authenticated('GET', '/auth/me', 200),
  authenticated('GET', '/auth/sessions', 200),
  authenticated('DELETE', `/auth/sessions/${U}`, 404),
];

/** Routes that are intentionally not in the matrix, and why. */
const NOT_IN_MATRIX: Record<string, string> = {
  'POST /auth/logout':
    'authenticated; it would end the shared test sessions (covered in auth.flows)',
  'POST /auth/password/change': 'authenticated; changes the shared test password (auth.flows)',
  'POST /auth/login': 'public',
  'POST /auth/password/forgot': 'public',
  'POST /auth/password/reset': 'public',
  'POST /auth/invites/accept': 'public',
  'GET /health/live': 'public',
  'GET /health/ready': 'public',
};

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
const routes: { key: string; kinds: number }[] = [];

// one client per caller, per host
let tenant: {
  anon: TestClient;
  member: TestClient;
  admin: TestClient;
  otherAdmin: TestClient;
  platform: TestClient;
};
let adminHost: { anon: TestClient; member: TestClient; admin: TestClient; platform: TestClient };

/** A client on `host` that replays the cookies of an already signed-in client (a different host). */
function replay(host: string, from: TestClient): TestClient {
  const c = new TestClient(t, host);
  c.cookies = new Map(from.cookies);
  return c;
}

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  t.app.addHook('onRoute', (route) => {
    // Fastify derives a HEAD route from every GET route; it carries the same declaration
    if (route.url.startsWith('/docs') || route.schema?.hide === true || route.method === 'HEAD')
      return;
    routes.push({
      key: `${String(route.method)} ${route.url}`,
      kinds: declarationCount(route.config as RouteDeclaration | undefined),
    });
  });
  A = await createAuthFixture(owner, 'mx-a');
  B = await createAuthFixture(owner, 'mx-b');
  const root = await createPlatformAdmin(owner, 'root@matrix.test');
  await t.app.ready();

  const login = async (host: string, email: string) => {
    const c = new TestClient(t, host);
    expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
    return c;
  };
  const member = await login(A.host, A.memberEmail);
  const admin = await login(A.host, A.adminEmail);
  const otherAdmin = await login(B.host, B.adminEmail);
  const platform = await login('admin.localhost', root.email);
  tenant = {
    anon: new TestClient(t, A.host),
    member,
    admin,
    otherAdmin: replay(A.host, otherAdmin), // college B's cookie presented to college A
    platform: replay(A.host, platform), // the platform admin's cookie presented to a tenant host
  };
  adminHost = {
    anon: new TestClient(t, 'admin.localhost'),
    member: replay('admin.localhost', member),
    admin: replay('admin.localhost', admin),
    platform,
  };
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

const send = (c: TestClient, row: Row) =>
  c.request(row.method, row.url, row.body === undefined ? {} : { body: row.body });

describe('authorization matrix: tenant host', () => {
  it.each(ROWS)('$endpoint', async (row) => {
    const callers = [
      tenant.anon,
      tenant.member,
      tenant.admin,
      tenant.otherAdmin,
      tenant.platform,
    ] as const;
    const names = [
      'anonymous',
      'member',
      'admin of this tenant',
      'admin of ANOTHER tenant',
      'platform admin on a tenant host',
    ];
    const actual: number[] = [];
    for (const c of callers) actual.push((await send(c, row)).statusCode);
    expect(Object.fromEntries(names.map((n, i) => [n, actual[i]])), row.endpoint).toEqual(
      Object.fromEntries(names.map((n, i) => [n, row.tenantHost[i]])),
    );
  });
});

describe('authorization matrix: admin host', () => {
  it.each(ROWS)('$endpoint', async (row) => {
    const callers = [
      adminHost.anon,
      adminHost.member,
      adminHost.admin,
      adminHost.platform,
    ] as const;
    const names = ['anonymous', 'tenant member', 'tenant admin', 'platform admin'];
    const actual: number[] = [];
    for (const c of callers) actual.push((await send(c, row)).statusCode);
    expect(Object.fromEntries(names.map((n, i) => [n, actual[i]])), row.endpoint).toEqual(
      Object.fromEntries(names.map((n, i) => [n, row.adminHost[i]])),
    );
  });
});

describe('the matrix covers the whole API', () => {
  it('every registered route is in the matrix or has a documented reason not to be', () => {
    const normalize = (url: string) => url.replace(/:[A-Za-z]+/g, U);
    const inMatrix = new Set(ROWS.map((r) => r.endpoint));
    const uncovered = routes
      .map((r) => r.key.replace(/^(\w+) (.*)$/, (_m, m, u) => `${m} ${normalize(u)}`))
      .filter(
        (k) => !inMatrix.has(k) && !(k.replace(U, ':x') in NOT_IN_MATRIX) && !(k in NOT_IN_MATRIX),
      );
    expect(uncovered).toEqual([]);
  });

  it('every route declares exactly one authorization kind', () => {
    expect(routes.filter((r) => r.kinds !== 1)).toEqual([]);
  });
});
