import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { lastTokenFor, TestClient } from './client';
import { addMember } from './fixtures';
import { createAuthFixture, createPlatformAdmin, TEST_PASSWORD, testOwnerPool } from './support';

// Platform-admin tenant management (admin host only). Real test database, real HTTP via inject().

type PageBody = {
  items: { id: string; action: string }[];
  nextCursor: string | null;
};

let owner: pg.Pool;
let t: TestApp;
let root: TestClient;
let rootId: string;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  const p = await createPlatformAdmin(owner, 'root@plat.test');
  rootId = p.userId;
  await t.app.ready();
  root = new TestClient(t, 'admin.localhost');
  expect((await root.login(p.email, TEST_PASSWORD)).statusCode).toBe(200);
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

const patch = (c: TestClient, url: string, body: unknown) => c.request('PATCH', url, { body });

async function createTenant(slug: string, name = `College ${slug}`) {
  const adminEmail = `first@${slug}.test`;
  const res = await root.post('/platform/tenants', {
    name,
    slug,
    adminEmail,
    adminName: 'First Admin',
  });
  expect(res.statusCode, res.body).toBe(201);
  return { ...res.json(), adminEmail } as {
    tenant: { id: string; slug: string; name: string; status: string };
    adminInvite: { outcome: string; userId: string; membershipId: string };
    adminEmail: string;
  };
}

const count = async (sql: string, params: unknown[]) =>
  (await owner.query(sql, params)).rows[0].n as number;

describe('POST /platform/tenants', () => {
  it('creates the college and invites its first admin, who can accept and log in', async () => {
    const slug = uniq('pt-new');
    const created = await createTenant(slug, 'New College');
    expect(created.tenant).toEqual(
      expect.objectContaining({ slug, name: 'New College', status: 'active' }),
    );
    expect(created.adminInvite.outcome).toBe('invited');

    // the invite goes to the first admin, with a link on the NEW college's own host
    const mail = t.mailer.sent.filter((m) => m.to === created.adminEmail).at(-1);
    expect(mail?.text).toContain(`http://${slug}.localhost`);
    const token = lastTokenFor(t, created.adminEmail);

    const host = `${slug}.localhost`;
    const first = new TestClient(t, host);
    // the slug cache did not remember "unknown" for the new slug
    expect(
      (await first.post('/auth/invites/accept', { token, password: TEST_PASSWORD })).statusCode,
    ).toBe(200);
    const login = await first.login(created.adminEmail, TEST_PASSWORD);
    expect(login.statusCode).toBe(200);
    expect(login.json().role).toBe('institution_admin');

    // audited: the platform log (both entries) and the invite also in the tenant's own log
    const log = (await root.get('/platform/audit', { query: 'limit=100' })).json().items;
    const actions = log
      .filter((e: { targetId: string }) => e.targetId === created.tenant.id)
      .map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['platform.tenant_created', 'platform.tenant_admin_invited']),
    );
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lms.audit_log WHERE tenant_id = $1 AND action = 'platform.tenant_admin_invited'",
        [created.tenant.id],
      ),
    ).toBe(1);
  });

  it('refuses reserved, malformed and duplicate slugs, and creates nothing', async () => {
    const body = (slug: string) => ({
      name: 'X',
      slug,
      adminEmail: 'x@bad-slug.test',
      adminName: 'X',
    });
    const reserved = await root.post('/platform/tenants', body('admin'));
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().error.code).toBe('reserved_slug');
    for (const slug of ['-bad-', 'Has_Underscore', 'ab', 'x'.repeat(64), 'spa ce']) {
      expect((await root.post('/platform/tenants', body(slug))).statusCode, slug).toBe(400);
    }
    const slug = uniq('pt-dup');
    await createTenant(slug);
    const dup = await root.post('/platform/tenants', { ...body(slug), adminEmail: 'y@dup.test' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('slug_taken');
    // the failed attempts left no half-created rows (one transaction)
    expect(
      await count('SELECT count(*)::int AS n FROM lms.users WHERE email = $1', ['x@bad-slug.test']),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int AS n FROM lms.users WHERE email = $1', ['y@dup.test']),
    ).toBe(0);
  });
});

describe('GET /platform/tenants', () => {
  it('lists with keyset pagination, searches name or slug prefix, and gives one tenant with counts', async () => {
    const tag = uniq('lst');
    const made: string[] = [];
    for (let i = 0; i < 5; i++)
      made.push((await createTenant(`${tag}-c${i}`, `Zebra ${tag} ${i}`)).tenant.id);

    const ids: string[] = [];
    let after: string | null = null;
    do {
      const body: PageBody = (
        await root.get('/platform/tenants', {
          query: `q=${tag}&limit=2${after ? `&after=${after}` : ''}`,
        })
      ).json();
      ids.push(...body.items.map((x: { id: string }) => x.id));
      after = body.nextCursor;
    } while (after);
    expect(ids).toEqual(made); // slug-prefix search, creation order, no duplicates, no gaps
    const byName = (
      await root.get('/platform/tenants', { query: `q=zebra ${tag}&limit=100` })
    ).json();
    expect(byName.items.map((x: { id: string }) => x.id)).toEqual(made);

    const one = (await root.get(`/platform/tenants/${made[0]}`)).json();
    expect(one).toEqual(expect.objectContaining({ id: made[0], members: 1, activeAdmins: 0 }));
    expect(
      (await root.get('/platform/tenants/00000000-0000-7000-8000-000000000000')).statusCode,
    ).toBe(404);
    expect((await root.get('/platform/tenants', { query: 'q=a' })).statusCode).toBe(400);
  });
});

describe('PATCH /platform/tenants/:id', () => {
  it('renames the college; the slug is immutable (API and database)', async () => {
    const c = await createTenant(uniq('pt-ren'), 'Old Name');
    const res = await patch(root, `/platform/tenants/${c.tenant.id}`, {
      name: 'New Name',
      slug: 'hacked-slug',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ name: 'New Name', slug: c.tenant.slug }));
    const log = (
      await root.get('/platform/audit', { query: 'action=platform.tenant_updated&limit=100' })
    ).json();
    const entry = log.items.find((e: { targetId: string }) => e.targetId === c.tenant.id);
    expect(entry.metadata).toEqual({ before: { name: 'Old Name' }, after: { name: 'New Name' } });

    await expect(
      owner.query("UPDATE lms.tenants SET slug = 'other-slug' WHERE id = $1", [c.tenant.id]),
    ).rejects.toThrow(/slug cannot be changed/);
    expect((await patch(root, `/platform/tenants/${c.tenant.id}`, { name: '' })).statusCode).toBe(
      400,
    );
    expect(
      (await patch(root, '/platform/tenants/00000000-0000-7000-8000-000000000000', { name: 'x' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('suspend / reactivate a college', () => {
  it('takes effect immediately for existing sessions, even on an instance with a stale slug cache', async () => {
    const f = await createAuthFixture(owner, uniq('pt-sus'));
    const admin = new TestClient(t, f.host);
    expect((await admin.login(f.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);

    // a second API instance that has the tenant in its slug cache (the 60 s TTL has not expired)
    const other = makeApp();
    await other.app.ready();
    const viaOther = new TestClient(other, f.host);
    viaOther.cookies = new Map(admin.cookies);
    expect((await viaOther.get('/auth/me')).statusCode).toBe(200);

    const res = await root.post(`/platform/tenants/${f.tenantId}/suspend`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('suspended');

    expect((await admin.get('/auth/me')).statusCode).toBe(404); // this instance: cache cleared
    expect((await viaOther.get('/auth/me')).statusCode).toBe(401); // stale cache: the session check stops it
    expect((await new TestClient(t, f.host).login(f.adminEmail, TEST_PASSWORD)).statusCode).toBe(
      404,
    );
    await other.close();

    // idempotent, audited once per real change
    expect((await root.post(`/platform/tenants/${f.tenantId}/suspend`)).statusCode).toBe(200);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lms.platform_audit_log WHERE action = 'platform.tenant_suspended' AND target_id = $1",
        [f.tenantId],
      ),
    ).toBe(1);

    const back = await root.post(`/platform/tenants/${f.tenantId}/reactivate`);
    expect(back.json().status).toBe('active');
    expect((await admin.get('/auth/me')).statusCode).toBe(200); // same session works again
    expect(
      (await root.post('/platform/tenants/00000000-0000-7000-8000-000000000000/suspend'))
        .statusCode,
    ).toBe(404);
  });
});

describe('POST /platform/tenants/:id/admin-invite', () => {
  it('invites a new institution admin (first invite expired / college lost its admin), audited in both logs', async () => {
    const c = await createTenant(uniq('pt-inv'));
    const oldToken = lastTokenFor(t, c.adminEmail);
    const email = `second@${c.tenant.slug}.test`;

    const res = await root.post(`/platform/tenants/${c.tenant.id}/admin-invite`, {
      email,
      displayName: 'Second Admin',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe('invited');
    const token = lastTokenFor(t, email);

    // both logs
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lms.audit_log WHERE tenant_id = $1 AND action = 'platform.tenant_admin_invited' AND actor_user_id = $2",
        [c.tenant.id, rootId],
      ),
    ).toBe(2); // first admin (at creation) + this one
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lms.platform_audit_log WHERE action = 'platform.tenant_admin_invited' AND target_id = $1 AND actor_user_id = $2",
        [c.tenant.id, rootId],
      ),
    ).toBe(2);

    // re-inviting the same address voids the earlier token (one live invite per person)
    await root.post(`/platform/tenants/${c.tenant.id}/admin-invite`, {
      email,
      displayName: 'Second Admin',
    });
    const newer = lastTokenFor(t, email);
    expect(newer).not.toBe(token);
    const host = new TestClient(t, `${c.tenant.slug}.localhost`);
    expect(
      (await host.post('/auth/invites/accept', { token, password: TEST_PASSWORD })).statusCode,
    ).toBe(400);
    expect(
      (await host.post('/auth/invites/accept', { token: newer, password: TEST_PASSWORD }))
        .statusCode,
    ).toBe(200);
    expect(oldToken).toBeTruthy();

    // now an active admin: inviting them again is a conflict
    const again = await root.post(`/platform/tenants/${c.tenant.id}/admin-invite`, {
      email,
      displayName: 'X',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_institution_admin');
  });

  it('promotes an existing ACTIVE member (and signs them out); refuses a suspended one; unknown college is 404', async () => {
    const f = await createAuthFixture(owner, uniq('pt-pro'));
    const member = new TestClient(t, f.host);
    await member.login(f.memberEmail, TEST_PASSWORD);
    const res = await root.post(`/platform/tenants/${f.tenantId}/admin-invite`, {
      email: f.memberEmail,
      displayName: 'Member',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe('promoted');
    // (a) the member is told, by email, without any link or token
    const note = t.mailer.sent.filter((m) => m.to === f.memberEmail).at(-1);
    expect(note?.subject).toBe(`You are now an institution admin of Tenant ${f.slug}`);
    expect(note?.text).toContain('signed out');
    expect(note?.text).not.toMatch(/token=|https?:\/\//);
    // (b) their old session in this college is gone, and a fresh login carries the new role
    expect((await member.get('/auth/me')).statusCode).toBe(401);
    expect((await new TestClient(t, f.host).login(f.memberEmail, TEST_PASSWORD)).json().role).toBe(
      'institution_admin',
    );

    // inviting someone who is already an admin is refused and sends nothing
    const mailsBefore = t.mailer.sent.length;
    const again = await root.post(`/platform/tenants/${f.tenantId}/admin-invite`, {
      email: f.memberEmail,
      displayName: 'Member',
    });
    expect(again.statusCode).toBe(409);
    expect(t.mailer.sent.length).toBe(mailsBefore);

    const s = await addMember(owner, f.tenantId, `${uniq('susp')}@pt.test`, {
      status: 'suspended',
    });
    const refused = await root.post(`/platform/tenants/${f.tenantId}/admin-invite`, {
      email: s.email,
      displayName: 'S',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('member_suspended');
    expect(t.mailer.sent.length).toBe(mailsBefore); // no notification for a refused promotion

    expect(
      (
        await root.post('/platform/tenants/00000000-0000-7000-8000-000000000000/admin-invite', {
          email: 'a@b.test',
          displayName: 'A',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('GET /platform/tenants/:id/members', () => {
  it('is a read-only view whose every call writes BOTH audit logs in the same transaction', async () => {
    const f = await createAuthFixture(owner, uniq('pt-mem'));
    const tenantLog = () =>
      count(
        "SELECT count(*)::int AS n FROM lms.audit_log WHERE tenant_id = $1 AND action = 'platform.tenant_members_read' AND actor_user_id = $2",
        [f.tenantId, rootId],
      );
    const platformLog = () =>
      count(
        "SELECT count(*)::int AS n FROM lms.platform_audit_log WHERE action = 'platform.tenant_members_read' AND target_id = $1",
        [f.tenantId],
      );
    const [t0, p0] = [await tenantLog(), await platformLog()];

    const res = await root.get(`/platform/tenants/${f.tenantId}/members`, { query: 'limit=50' });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .items.map((m: { email: string }) => m.email)
        .sort(),
    ).toEqual([f.adminEmail, f.memberEmail].sort());
    expect(await tenantLog()).toBe(t0 + 1);
    expect(await platformLog()).toBe(p0 + 1);

    const filtered = await root.get(`/platform/tenants/${f.tenantId}/members`, {
      query: 'role=institution_admin',
    });
    expect(filtered.json().items).toHaveLength(1);
    expect(await tenantLog()).toBe(t0 + 2);
    expect(await platformLog()).toBe(p0 + 2);

    // an unknown college: 404 and nothing was recorded for it
    const none = await root.get('/platform/tenants/00000000-0000-7000-8000-000000000000/members');
    expect(none.statusCode).toBe(404);
    // no write endpoint exists under it
    expect((await root.post(`/platform/tenants/${f.tenantId}/members`, {})).statusCode).toBe(404);
  });
});

describe('GET /platform/audit', () => {
  it('filters by action and date range, paginates without duplicates or gaps, newest first', async () => {
    // the window starts NOW: entries of earlier tests (a fast local database finishes them within the same
    // second) must stay outside it
    const from = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));
    const c = await createTenant(uniq('pt-aud'));
    for (let i = 0; i < 4; i++) {
      await root.post(`/platform/tenants/${c.tenant.id}/suspend`);
      await root.post(`/platform/tenants/${c.tenant.id}/reactivate`);
    }
    const to = new Date(Date.now() + 60_000).toISOString();
    const q = `action=platform.tenant_suspended&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const ids: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const body: PageBody = (
        await root.get('/platform/audit', {
          query: `${q}&limit=3${after ? `&after=${after}` : ''}`,
        })
      ).json();
      ids.push(...body.items.map((e: { id: string }) => e.id));
      after = body.nextCursor;
      pages++;
    } while (after);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(pages).toBe(2);
    const all = (await root.get('/platform/audit', { query: 'limit=100' })).json().items;
    const times = all.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await root.get('/platform/audit', { query: 'after=forged' })).json().error.code).toBe(
      'invalid_cursor',
    );
    expect((await root.get('/platform/audit', { query: 'from=nope' })).statusCode).toBe(400);
  });
});
