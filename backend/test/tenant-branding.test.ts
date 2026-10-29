import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// College branding: the PUBLIC GET /tenant/info (resolved by Host) and PATCH /tenant/branding, and the
// permissions list of /auth/me that the UI uses to decide what to show.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let member: TestClient;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'brand-a');
  B = await createAuthFixture(owner, 'brand-b');
  await t.app.ready();
  admin = new TestClient(t, A.host);
  member = new TestClient(t, A.host);
  expect((await admin.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
  expect((await member.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('GET /tenant/info (public)', () => {
  it('answers without a session with EXACTLY slug, displayName and primaryColor', async () => {
    const res = await new TestClient(t, B.host).get('/tenant/info');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // nothing else can leak: no id, no status, no settings, no timestamps
    expect(Object.keys(body).sort()).toEqual(['displayName', 'primaryColor', 'slug']);
    expect(body).toEqual({
      slug: 'brand-b',
      displayName: expect.any(String),
      primaryColor: '#2563eb', // the default until the college sets its own
    });
    for (const secret of [B.tenantId, A.tenantId, 'status', 'tenant_id', 'updated']) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('is rate limited like every other public route (it does not opt out)', async () => {
    const res = await new TestClient(t, A.host).get('/tenant/info');
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('is 404 for an unknown college and on the admin host', async () => {
    expect((await new TestClient(t, 'nobody-here.localhost').get('/tenant/info')).statusCode).toBe(
      404,
    );
    expect((await new TestClient(t, 'admin.localhost').get('/tenant/info')).statusCode).toBe(404);
  });

  it('is 404 for a suspended college', async () => {
    const S = await createAuthFixture(owner, 'brand-s');
    await owner.query("UPDATE lms.tenants SET status = 'suspended' WHERE id = $1", [S.tenantId]);
    t.app.modules.tenants.service.clearCache();
    expect((await new TestClient(t, S.host).get('/tenant/info')).statusCode).toBe(404);
  });
});

describe('PATCH /tenant/branding', () => {
  it('lets an institution admin set the display name and colour; everyone then sees it', async () => {
    const res = await admin.patch('/tenant/branding', {
      displayName: '  Alpha Institute of Technology ',
      primaryColor: '#1A2B3C',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      slug: 'brand-a',
      displayName: 'Alpha Institute of Technology', // trimmed
      primaryColor: '#1a2b3c', // stored lowercase
    });
    const pub = await new TestClient(t, A.host).get('/tenant/info');
    expect(pub.json()).toEqual(res.json());
    // another college is untouched
    expect((await new TestClient(t, B.host).get('/tenant/info')).json().primaryColor).toBe(
      '#2563eb',
    );
  });

  it('is audited with before and after', async () => {
    await admin.patch('/tenant/branding', { displayName: 'Alpha Two', primaryColor: '#00ff00' });
    const { rows } = await owner.query(
      "SELECT metadata FROM lms.audit_log WHERE tenant_id = $1 AND action = 'tenant.branding_updated' ORDER BY id DESC LIMIT 1",
      [A.tenantId],
    );
    expect(rows[0].metadata.before.displayName).toBe('Alpha Institute of Technology');
    expect(rows[0].metadata.after).toEqual({ displayName: 'Alpha Two', primaryColor: '#00ff00' });
  });

  it('rejects members (403), anonymous callers (401) and invalid input (400)', async () => {
    const ok = { displayName: 'X', primaryColor: '#123456' };
    expect((await member.patch('/tenant/branding', ok)).statusCode).toBe(403);
    expect((await new TestClient(t, A.host).patch('/tenant/branding', ok)).statusCode).toBe(401);
    for (const bad of [
      { displayName: 'X', primaryColor: 'red' },
      { displayName: 'X', primaryColor: '#12345' },
      { displayName: 'X', primaryColor: '#12345g' },
      { displayName: 'X', primaryColor: 'url(javascript:alert(1))' },
      { displayName: '', primaryColor: '#123456' },
      { displayName: 'x'.repeat(81), primaryColor: '#123456' },
    ]) {
      expect((await admin.patch('/tenant/branding', bad)).statusCode, JSON.stringify(bad)).toBe(
        400,
      );
    }
    // a blank (whitespace only) name passes the length rule but is refused by the service
    expect(
      (await admin.patch('/tenant/branding', { displayName: '   ', primaryColor: '#123456' }))
        .statusCode,
    ).toBe(400);
  });

  it('ignores a corrupted stored value and falls back to the defaults', async () => {
    const C = await createAuthFixture(owner, 'brand-c');
    await owner.query(
      'INSERT INTO lms.tenant_settings (id, tenant_id, key, value) VALUES (gen_random_uuid(), $1, \'branding\', \'{"primaryColor": "javascript:x", "displayName": 7}\')',
      [C.tenantId],
    );
    const body = (await new TestClient(t, C.host).get('/tenant/info')).json();
    expect(body.primaryColor).toBe('#2563eb');
    expect(typeof body.displayName).toBe('string');
    expect(body.displayName.length).toBeGreaterThan(0);
  });
});

describe('GET /auth/me permissions (the UI hides what you cannot do; the backend still enforces it)', () => {
  it('lists the account-level permissions of the role', async () => {
    const adminMe = (await admin.get('/auth/me')).json();
    expect(adminMe.permissions).toEqual(
      expect.arrayContaining(['member.read', 'import.run', 'tenant.manage', 'audit.read']),
    );
    expect(adminMe.permissions).not.toContain('platform.tenant.manage');
    expect(adminMe.permissions).not.toContain('course.edit');

    const memberMe = (await member.get('/auth/me')).json();
    expect(memberMe.permissions).toEqual(
      expect.arrayContaining(['academic.read', 'profile.read_own']),
    );
    for (const p of ['member.read', 'import.run', 'tenant.manage']) {
      expect(memberMe.permissions).not.toContain(p);
    }
  });

  it('lists platform permissions only on the admin host', async () => {
    const root = await createPlatformAdmin(owner, 'brand-root@platform.test');
    const pc = new TestClient(t, 'admin.localhost');
    expect((await pc.login(root.email, TEST_PASSWORD)).statusCode).toBe(200);
    const me = (await pc.get('/auth/me')).json();
    expect(me.permissions).toEqual(
      expect.arrayContaining(['platform.tenant.read', 'platform.tenant.manage']),
    );
    expect(me.permissions).not.toContain('member.read');
  });
});
