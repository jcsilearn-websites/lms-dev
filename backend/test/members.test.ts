import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLastAdminViolation, pgErrorCode } from '../src/db/pg-errors';
import { makeApp, type TestApp } from './app';
import { lastTokenFor, TestClient } from './client';
import { addMember } from './fixtures';
import {
  type AuthFixture,
  createAuthFixture,
  createTenantFixture,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// Member management (tenant host, institution admin). Real test database, real HTTP via inject().

type PageBody = {
  items: { id: string; action: string }[];
  nextCursor: string | null;
};

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'mem-a');
  B = await createAuthFixture(owner, 'mem-b');
  await t.app.ready();
  admin = new TestClient(t, A.host);
  expect((await admin.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

const patch = (c: TestClient, url: string, body: unknown) => c.request('PATCH', url, { body });

async function loggedIn(host: string, email: string): Promise<TestClient> {
  const c = new TestClient(t, host);
  expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
  return c;
}

/** Walks every page of GET /members with the given query; returns all items in order. */
async function allMembers(c: TestClient, query: string, limit = 3) {
  const items: { id: string; userId: string; email: string }[] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const res = await c.get('/members', {
      query: `${query}&limit=${limit}${after ? `&after=${after}` : ''}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    items.push(...body.items);
    after = body.nextCursor;
    if (!after) return items;
  }
  throw new Error('pagination did not terminate');
}

describe('GET /members', () => {
  it('lists the tenant members with the user joined in (no other tenant leaks in)', async () => {
    const res = await admin.get('/members');
    expect(res.statusCode).toBe(200);
    const { items, nextCursor } = res.json();
    expect(nextCursor).toBeNull();
    const emails = items.map((m: { email: string }) => m.email);
    expect(emails).toContain(A.adminEmail);
    expect(emails).toContain(A.memberEmail);
    expect(emails).not.toContain(B.adminEmail);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        userId: expect.any(String),
        displayName: expect.any(String),
        role: expect.stringMatching(/^(institution_admin|member)$/),
        status: expect.stringMatching(/^(active|pending|suspended)$/),
        createdAt: expect.any(String),
      }),
    );
  });

  it('filters by role and status', async () => {
    const tag = uniq('flt');
    const pending = await addMember(owner, A.tenantId, `${tag}-p@mem-a.test`, {
      status: 'pending',
    });
    const suspended = await addMember(owner, A.tenantId, `${tag}-s@mem-a.test`, {
      status: 'suspended',
    });
    const byStatus = async (s: string) =>
      (await allMembers(admin, `status=${s}`)).map((m) => m.userId);
    expect(await byStatus('pending')).toContain(pending.userId);
    expect(await byStatus('pending')).not.toContain(suspended.userId);
    expect(await byStatus('suspended')).toContain(suspended.userId);
    const admins = await allMembers(admin, 'role=institution_admin');
    expect(admins.map((m) => m.userId)).toContain(A.adminUserId);
    expect(admins.map((m) => m.userId)).not.toContain(A.memberUserId);
    expect((await admin.get('/members', { query: 'role=student' })).statusCode).toBe(400);
    expect((await admin.get('/members', { query: 'status=gone' })).statusCode).toBe(400);
  });

  it('searches by email or name PREFIX, case-insensitively, with wildcards taken literally', async () => {
    const tag = uniq('zq');
    const ada = await addMember(owner, A.tenantId, `${tag}.ada@mem-a.test`, {
      displayName: `Zqname ${tag}`,
    });
    await addMember(owner, B.tenantId, `${tag}.other@mem-b.test`, { displayName: `Zqname ${tag}` });
    const byName = await allMembers(admin, `q=ZQNAME ${tag}`);
    expect(byName.map((m) => m.userId)).toEqual([ada.userId]); // not the other tenant's namesake
    const byEmail = await allMembers(admin, `q=${tag}.ada`);
    expect(byEmail.map((m) => m.userId)).toEqual([ada.userId]);
    // a prefix, not "contains"
    expect(await allMembers(admin, `q=ada@mem-a`)).toEqual([]);
    // % and _ are literal characters: they do not turn the search into "match everything"
    expect(await allMembers(admin, 'q=%25%25')).toEqual([]);
    expect(await allMembers(admin, 'q=__')).toEqual([]);
    expect((await admin.get('/members', { query: 'q=a' })).statusCode).toBe(400);
  });

  it('paginates with a stable sort: no duplicates, no gaps', async () => {
    const tag = uniq('pg');
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      created.push((await addMember(owner, A.tenantId, `${tag}-${i}@mem-a.test`)).userId);
    }
    const all = await allMembers(admin, `q=${tag}`, 2); // 4 pages of 2,2,2,1
    expect(all.map((m) => m.userId)).toEqual(created); // creation order (UUIDv7)
    expect(new Set(all.map((m) => m.id)).size).toBe(7);
    const unfiltered = await allMembers(admin, '', 4);
    expect(new Set(unfiltered.map((m) => m.id)).size).toBe(unfiltered.length);
  });

  it('stays consistent when members are inserted between page fetches', async () => {
    const tag = uniq('ins');
    const first: string[] = [];
    for (let i = 0; i < 5; i++) {
      first.push((await addMember(owner, A.tenantId, `${tag}-a${i}@mem-a.test`)).userId);
    }
    const p1 = (await admin.get('/members', { query: `q=${tag}&limit=2` })).json();
    expect(p1.items).toHaveLength(2);
    // two newcomers arrive while the client is paging
    const late = [
      (await addMember(owner, A.tenantId, `${tag}-b1@mem-a.test`)).userId,
      (await addMember(owner, A.tenantId, `${tag}-b2@mem-a.test`)).userId,
    ];
    const seen = p1.items.map((m: { userId: string }) => m.userId);
    let after: string | null = p1.nextCursor;
    while (after) {
      const p = (await admin.get('/members', { query: `q=${tag}&limit=2&after=${after}` })).json();
      seen.push(...p.items.map((m: { userId: string }) => m.userId));
      after = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen.slice(0, 5)).toEqual(first); // nothing shifted, nothing skipped
    expect(seen).toEqual(expect.arrayContaining(late)); // later rows simply appear at the end
  });

  it('rejects a malformed cursor and out-of-range limits', async () => {
    expect((await admin.get('/members', { query: 'after=not-a-uuid' })).json().error.code).toBe(
      'invalid_cursor',
    );
    expect((await admin.get('/members', { query: 'limit=0' })).statusCode).toBe(400);
    expect((await admin.get('/members', { query: 'limit=101' })).statusCode).toBe(400);
  });
});

describe('GET /members/:userId', () => {
  it('returns one member; unknown ids and members of other tenants are 404', async () => {
    const res = await admin.get(`/members/${A.memberUserId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({ userId: A.memberUserId, email: A.memberEmail, role: 'member' }),
    );
    expect((await admin.get(`/members/${B.memberUserId}`)).json().error.code).toBe(
      'member_not_found',
    );
    expect((await admin.get('/members/00000000-0000-7000-8000-000000000000')).statusCode).toBe(404);
    expect((await admin.get('/members/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('PATCH /members/:userId/role', () => {
  it('changes the role, revokes that user sessions here, and audits before/after', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('role')}@mem-a.test`);
    const victim = await loggedIn(A.host, u.email);
    expect((await victim.get('/auth/me')).statusCode).toBe(200);

    const res = await patch(admin, `/members/${u.userId}/role`, { role: 'institution_admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('institution_admin');
    expect((await victim.get('/auth/me')).statusCode).toBe(401); // must sign in again
    expect((await new TestClient(t, A.host).login(u.email, TEST_PASSWORD)).json().role).toBe(
      'institution_admin',
    );

    const log = (
      await admin.get('/audit', { query: 'action=member.role_changed&limit=100' })
    ).json();
    const entry = log.items.find((e: { targetId: string }) => e.targetId === u.membershipId);
    expect(entry).toEqual(
      expect.objectContaining({
        actorUserId: A.adminUserId,
        targetType: 'membership',
        metadata: expect.objectContaining({
          userId: u.userId,
          before: { role: 'member', status: 'active' },
          after: { role: 'institution_admin', status: 'active' },
        }),
      }),
    );
    // and back (another admin exists, so the invariant holds)
    expect((await patch(admin, `/members/${u.userId}/role`, { role: 'member' })).statusCode).toBe(
      200,
    );
  });

  it('is a no-op for the same role: no audit entry, sessions untouched', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('same')}@mem-a.test`);
    const c = await loggedIn(A.host, u.email);
    const before = (
      await admin.get('/audit', { query: 'action=member.role_changed&limit=100' })
    ).json().items.length;
    expect((await patch(admin, `/members/${u.userId}/role`, { role: 'member' })).statusCode).toBe(
      200,
    );
    expect((await c.get('/auth/me')).statusCode).toBe(200);
    const after = (
      await admin.get('/audit', { query: 'action=member.role_changed&limit=100' })
    ).json().items.length;
    expect(after).toBe(before);
  });

  it('rejects unknown roles and unknown members', async () => {
    expect(
      (await patch(admin, `/members/${A.memberUserId}/role`, { role: 'teacher' })).statusCode,
    ).toBe(400);
    expect(
      (await patch(admin, '/members/00000000-0000-7000-8000-000000000000/role', { role: 'member' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('self-protection', () => {
  it('an admin cannot demote, suspend or remove themselves', async () => {
    for (const res of [
      await patch(admin, `/members/${A.adminUserId}/role`, { role: 'member' }),
      await admin.post(`/members/${A.adminUserId}/suspend`),
      await admin.delete(`/members/${A.adminUserId}`),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('cannot_modify_self');
    }
    expect((await admin.get('/auth/me')).statusCode).toBe(200);
  });
});

describe('suspend / reactivate', () => {
  it('suspension revokes sessions and blocks login; reactivation restores access', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('sus')}@mem-a.test`);
    const c = await loggedIn(A.host, u.email);

    const res = await admin.post(`/members/${u.userId}/suspend`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('suspended');
    expect((await c.get('/auth/me')).statusCode).toBe(401);
    const denied = await new TestClient(t, A.host).login(u.email, TEST_PASSWORD);
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('invalid_credentials'); // generic: no hint

    expect((await admin.post(`/members/${u.userId}/suspend`)).json().error.code).toBe(
      'member_not_active',
    );
    const back = await admin.post(`/members/${u.userId}/reactivate`);
    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe('active');
    expect((await new TestClient(t, A.host).login(u.email, TEST_PASSWORD)).statusCode).toBe(200);
    expect((await admin.post(`/members/${u.userId}/reactivate`)).json().error.code).toBe(
      'member_not_suspended',
    );
  });

  it('a pending member cannot be suspended (remove them instead)', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('pend')}@mem-a.test`, {
      status: 'pending',
    });
    expect((await admin.post(`/members/${u.userId}/suspend`)).json().error.code).toBe(
      'member_not_active',
    );
  });

  it('suspended members stay suspended when they present an old invite token', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('tok')}@mem-a.test`, {
      status: 'pending',
    });
    await admin.post(`/members/${u.userId}/resend-invite`);
    const token = lastTokenFor(t, u.email);
    await owner.query("UPDATE lms.tenant_memberships SET status = 'suspended' WHERE id = $1", [
      u.membershipId,
    ]);
    const accept = await new TestClient(t, A.host).post('/auth/invites/accept', { token });
    expect(accept.statusCode).toBe(400);
    const row = await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [
      u.membershipId,
    ]);
    expect(row.rows[0].status).toBe('suspended');
  });
});

describe('DELETE /members/:userId', () => {
  it('removal is SOFT: the membership stays as "removed", access is gone, the global user and other colleges are untouched', async () => {
    const email = `${uniq('rm')}@shared.test`;
    const inA = await addMember(owner, A.tenantId, email);
    // the same person is also a member of college B
    await owner.query(
      'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)',
      [B.tenantId, inA.userId, 'member'],
    );
    const sessionA = await loggedIn(A.host, email);
    const sessionB = await loggedIn(B.host, email);

    const res = await admin.delete(`/members/${inA.userId}`);
    expect(res.statusCode).toBe(200);
    // the row is still there, with the new status (history hangs off it)
    const row = await owner.query(
      'SELECT id, status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, inA.userId],
    );
    expect(row.rows).toEqual([{ id: inA.membershipId, status: 'removed' }]);
    expect((await admin.get(`/members/${inA.userId}`)).json().status).toBe('removed');

    const user = await owner.query('SELECT id FROM lms.users WHERE id = $1', [inA.userId]);
    expect(user.rowCount).toBe(1); // the global user is still there
    expect((await sessionA.get('/auth/me')).statusCode).toBe(401); // sessions revoked, access gone
    expect((await sessionB.get('/auth/me')).statusCode).toBe(200); // still a member of B
    expect((await new TestClient(t, A.host).login(email, TEST_PASSWORD)).statusCode).toBe(401); // cannot sign in again
    expect((await admin.delete(`/members/${inA.userId}`)).statusCode).toBe(404); // already removed

    // lists hide removed members unless asked
    const ids = async (query: string) =>
      (await admin.get('/members', { query: `${query}&limit=100` }))
        .json()
        .items.map((m: { userId: string }) => m.userId);
    expect(await ids('role=member')).not.toContain(inA.userId);
    expect(await ids('status=removed')).toContain(inA.userId);
    // a removed member cannot be changed like a live one
    expect(
      (await admin.patch(`/members/${inA.userId}/role`, { role: 'institution_admin' })).statusCode,
    ).toBe(404);
    expect((await admin.post(`/members/${inA.userId}/suspend`)).statusCode).toBe(409);

    const log = (await admin.get('/audit', { query: 'action=member.removed&limit=100' })).json();
    expect(log.items[0].metadata).toEqual(
      expect.objectContaining({
        userId: inA.userId,
        before: { role: 'member', status: 'active' },
        after: { role: 'member', status: 'removed' },
      }),
    );
  });

  it('inviting a removed member again brings back the SAME membership (pending, then active on accept)', async () => {
    const email = `${uniq('back')}@mem-a.test`;
    const m = await addMember(owner, A.tenantId, email);
    expect((await admin.delete(`/members/${m.userId}`)).statusCode).toBe(200);
    const invite = await admin.post('/auth/invites', { email, role: 'member' });
    expect(invite.statusCode, invite.body).toBeLessThan(300);
    const now = await owner.query(
      'SELECT id, status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, m.userId],
    );
    expect(now.rows).toEqual([{ id: m.membershipId, status: 'pending' }]); // one row, the same id
    const token = lastTokenFor(t, email);
    const accepted = await new TestClient(t, A.host).post('/auth/invites/accept', {
      token,
      password: TEST_PASSWORD,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const after = await owner.query(
      'SELECT id, status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, m.userId],
    );
    expect(after.rows).toEqual([{ id: m.membershipId, status: 'active' }]);
  });

  it('the app role cannot hard-delete a membership at all', async () => {
    const m = await addMember(owner, A.tenantId, `${uniq('nodel')}@mem-a.test`);
    const err = await t.db
      .withTenant(A.tenantId, (tx) =>
        tx.execute(sql`DELETE FROM lms.tenant_memberships WHERE id = ${m.membershipId}::uuid`),
      )
      .catch((e: unknown) => e);
    expect(pgErrorCode(err)).toBe('42501');
  });

  it('removing a pending member voids their invite token', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('rmp')}@mem-a.test`, {
      status: 'pending',
    });
    await admin.post(`/members/${u.userId}/resend-invite`);
    const token = lastTokenFor(t, u.email);
    expect((await admin.delete(`/members/${u.userId}`)).statusCode).toBe(200);
    expect(
      (await new TestClient(t, A.host).post('/auth/invites/accept', { token })).statusCode,
    ).toBe(400);
  });
});

describe('POST /members/:userId/resend-invite', () => {
  it('sends a new invite and the previous token stops working', async () => {
    const email = `${uniq('inv')}@mem-a.test`;
    expect(
      (await admin.post('/auth/invites', { email, role: 'member', displayName: 'New Person' }))
        .statusCode,
    ).toBe(201);
    const first = lastTokenFor(t, email);
    const userId = (await allMembers(admin, `q=${email}`))[0]?.userId as string;

    const res = await admin.post(`/members/${userId}/resend-invite`);
    expect(res.statusCode).toBe(200);
    const second = lastTokenFor(t, email);
    expect(second).not.toBe(first);

    const anon = new TestClient(t, A.host);
    expect(
      (await anon.post('/auth/invites/accept', { token: first, password: TEST_PASSWORD }))
        .statusCode,
    ).toBe(400);
    expect(
      (await anon.post('/auth/invites/accept', { token: second, password: TEST_PASSWORD }))
        .statusCode,
    ).toBe(200);

    const log = (
      await admin.get('/audit', { query: 'action=member.invite_resent&limit=100' })
    ).json();
    expect(
      log.items.some((e: { metadata: { userId: string } }) => e.metadata.userId === userId),
    ).toBe(true);
  });

  it('is for pending members only, and unknown members are 404', async () => {
    const res = await admin.post(`/members/${A.memberUserId}/resend-invite`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('member_not_pending');
    expect(
      (await admin.post('/members/00000000-0000-7000-8000-000000000000/resend-invite')).statusCode,
    ).toBe(404);
  });
});

describe('GET /audit', () => {
  it('filters by action and date range and paginates without duplicates or gaps', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('aud')}@mem-a.test`);
    // the window starts NOW: entries of earlier tests (a fast local database finishes them within the same
    // second) must stay outside it
    const from = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));
    for (let i = 0; i < 4; i++) {
      await admin.post(`/members/${u.userId}/suspend`);
      await admin.post(`/members/${u.userId}/reactivate`);
    }
    const to = new Date(Date.now() + 60_000).toISOString();
    const q = `action=member.suspended&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const ids: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const body: PageBody = (
        await admin.get('/audit', { query: `${q}&limit=3${after ? `&after=${after}` : ''}` })
      ).json();
      ids.push(...body.items.map((e: { id: string }) => e.id));
      for (const e of body.items) expect(e.action).toBe('member.suspended');
      after = body.nextCursor;
      pages++;
    } while (after);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(pages).toBe(2);

    // newest first
    const all = (await admin.get('/audit', { query: 'limit=100' })).json().items;
    const times = all.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // a range in the past yields nothing
    const past = (
      await admin.get('/audit', {
        query: `from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z`,
      })
    ).json();
    expect(past.items).toEqual([]);
  });

  it('rejects bad dates, inverted ranges and forged cursors', async () => {
    expect((await admin.get('/audit', { query: 'from=yesterday' })).statusCode).toBe(400);
    expect(
      (
        await admin.get('/audit', { query: 'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z' })
      ).json().error.code,
    ).toBe('invalid_date_range');
    expect((await admin.get('/audit', { query: 'after=forged' })).json().error.code).toBe(
      'invalid_cursor',
    );
  });

  it("only shows this tenant's entries", async () => {
    const bAdmin = await loggedIn(B.host, B.adminEmail);
    const mine = (await admin.get('/audit', { query: 'limit=100' })).json().items;
    const theirs = (await bAdmin.get('/audit', { query: 'limit=100' })).json().items;
    const ids = new Set(mine.map((e: { id: string }) => e.id));
    expect(theirs.every((e: { id: string }) => !ids.has(e.id))).toBe(true);
  });
});

describe('last active institution admin (database invariant)', () => {
  const lastAdmin = async (slug: string) => {
    const f = await createTenantFixture(owner, slug);
    return f; // exactly one active institution_admin (+ one member)
  };
  const update = (tenantId: string, statement: ReturnType<typeof sql>) =>
    t.db.withTenant(tenantId, (tx) => tx.execute(statement));

  it('lms_app is NOT exempt: demoting, suspending or removing the last admin is refused by the database', async () => {
    const f = await lastAdmin('mem-last-1');
    for (const statement of [
      sql`UPDATE lms.tenant_memberships SET role = 'member' WHERE id = ${f.adminMembershipId}::uuid`,
      sql`UPDATE lms.tenant_memberships SET status = 'suspended' WHERE id = ${f.adminMembershipId}::uuid`,
      sql`UPDATE lms.tenant_memberships SET status = 'removed' WHERE id = ${f.adminMembershipId}::uuid`,
    ]) {
      const err = await update(f.tenantId, statement).catch((e: unknown) => e);
      expect(isLastAdminViolation(err), String(err)).toBe(true);
      expect(pgErrorCode(err)).toBe('23514');
    }
    const still = await owner.query(
      'SELECT role, status FROM lms.tenant_memberships WHERE id = $1',
      [f.adminMembershipId],
    );
    expect(still.rows[0]).toEqual({ role: 'institution_admin', status: 'active' });
  });

  it('allows removing an admin while another active admin remains, then refuses the last one', async () => {
    const f = await lastAdmin('mem-last-2');
    const second = await addMember(owner, f.tenantId, 'second@mem-last-2.test', {
      role: 'institution_admin',
    });
    await update(
      f.tenantId,
      sql`UPDATE lms.tenant_memberships SET role = 'member' WHERE id = ${second.membershipId}::uuid`,
    );
    const err = await update(
      f.tenantId,
      sql`UPDATE lms.tenant_memberships SET role = 'member' WHERE id = ${f.adminMembershipId}::uuid`,
    ).catch((e: unknown) => e);
    expect(isLastAdminViolation(err)).toBe(true);
  });

  it('a pending or suspended admin does not count as an active one', async () => {
    const f = await lastAdmin('mem-last-3');
    await addMember(owner, f.tenantId, 'pend@mem-last-3.test', {
      role: 'institution_admin',
      status: 'pending',
    });
    await addMember(owner, f.tenantId, 'susp@mem-last-3.test', {
      role: 'institution_admin',
      status: 'suspended',
    });
    const err = await update(
      f.tenantId,
      sql`UPDATE lms.tenant_memberships SET status = 'suspended' WHERE id = ${f.adminMembershipId}::uuid`,
    ).catch((e: unknown) => e);
    expect(isLastAdminViolation(err)).toBe(true);
  });

  it('the table owner (maintenance) is exempt, so whole tenants can be cleaned up', async () => {
    const f = await lastAdmin('mem-last-4');
    await owner.query('DELETE FROM lms.tenant_memberships WHERE id = $1', [f.adminMembershipId]);
    const left = await owner.query('SELECT 1 FROM lms.tenant_memberships WHERE id = $1', [
      f.adminMembershipId,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('a tenant with no active admin yet (first invite pending) can be created and accepts the invite', async () => {
    const tenantId = (
      await owner.query(
        "INSERT INTO lms.tenants (id, slug, name) VALUES (gen_random_uuid(), 'mem-last-5', 'x') RETURNING id",
      )
    ).rows[0].id as string;
    const m = await addMember(owner, tenantId, 'first@mem-last-5.test', {
      role: 'institution_admin',
      status: 'pending',
    });
    await update(
      tenantId,
      sql`UPDATE lms.tenant_memberships SET status = 'active' WHERE id = ${m.membershipId}::uuid`,
    );
  });

  it('CONCURRENT demotions of each other: exactly one succeeds (deterministic, database level)', async () => {
    const f = await lastAdmin('mem-last-6');
    const other = await addMember(owner, f.tenantId, 'other@mem-last-6.test', {
      role: 'institution_admin',
    });
    // tx1 demotes `other` and holds its transaction open; tx2 (started meanwhile) demotes the first
    // admin. tx2 must wait on the per-tenant lock, then see tx1's commit and be refused.
    const tx1 = t.db.withTenant(f.tenantId, async (tx) => {
      await tx.execute(
        sql`UPDATE lms.tenant_memberships SET role = 'member' WHERE id = ${other.membershipId}::uuid`,
      );
      await tx.execute(sql`SELECT pg_sleep(1.5)`);
    });
    await new Promise((r) => setTimeout(r, 400));
    const tx2 = t.db.withTenant(f.tenantId, (tx) =>
      tx.execute(
        sql`UPDATE lms.tenant_memberships SET role = 'member' WHERE id = ${f.adminMembershipId}::uuid`,
      ),
    );
    const [r1, r2] = await Promise.allSettled([tx1, tx2]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    expect(isLastAdminViolation((r2 as PromiseRejectedResult).reason)).toBe(true);
    const admins = await owner.query(
      "SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE tenant_id = $1 AND role = 'institution_admin' AND status = 'active'",
      [f.tenantId],
    );
    expect(admins.rows[0].n).toBe(1);
  });

  it('CONCURRENT demotions through the API: two admins demote each other at once, one stays', async () => {
    const f = await createAuthFixture(owner, 'mem-last-7');
    const second = await addMember(owner, f.tenantId, 'second@mem-last-7.test', {
      role: 'institution_admin',
    });
    const c1 = await loggedIn(f.host, f.adminEmail);
    const c2 = await loggedIn(f.host, second.email);
    const [r1, r2] = await Promise.all([
      patch(c1, `/members/${second.userId}/role`, { role: 'member' }),
      patch(c2, `/members/${f.adminUserId}/role`, { role: 'member' }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    // one wins; the loser is refused by the invariant (409) or already signed out by the winner (401)
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);
    const admins = await owner.query(
      "SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE tenant_id = $1 AND role = 'institution_admin' AND status = 'active'",
      [f.tenantId],
    );
    expect(admins.rows[0].n).toBe(1);
  });
});

describe('tenant-scoped search keys', () => {
  it('are filled on insert and follow a rename of the user', async () => {
    const u = await addMember(owner, A.tenantId, `${uniq('key')}@mem-a.test`, {
      displayName: 'Keyed Person',
    });
    const read = () =>
      owner.query('SELECT search_name, search_email FROM lms.tenant_memberships WHERE id = $1', [
        u.membershipId,
      ]);
    expect((await read()).rows[0]).toEqual({
      search_name: 'keyed person',
      search_email: u.email,
    });
    await owner.query("UPDATE lms.users SET display_name = 'Renamed Person' WHERE id = $1", [
      u.userId,
    ]);
    expect((await read()).rows[0].search_name).toBe('renamed person');
    const found = await allMembers(admin, 'q=renamed');
    expect(found.map((m) => m.userId)).toContain(u.userId);
  });
});
