import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { addMember } from './fixtures';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// The audit log shows who did it: display name and email next to the actor id, from the SAME query
// (a join), under row-level security. An actor who cannot be read any more is "Unknown user".

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let root: TestClient;
let rootUserId: string;

type Entry = {
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'aud-a');
  const platform = await createPlatformAdmin(owner, 'root@audit-actors.test');
  rootUserId = platform.userId;
  await t.app.ready();
  admin = new TestClient(t, A.host);
  expect((await admin.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
  root = new TestClient(t, 'admin.localhost');
  expect((await root.login(platform.email, TEST_PASSWORD)).statusCode).toBe(200);
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

const tenantLog = async (query: string): Promise<Entry[]> =>
  (await admin.get('/audit', { query })).json().items;

describe('GET /audit: who did it', () => {
  it('returns the name and email of the actor, together with the id', async () => {
    const victim = await addMember(owner, A.tenantId, 'victim@aud-a.test', { displayName: 'Vic' });
    expect((await admin.post(`/members/${victim.userId}/suspend`)).statusCode).toBe(200);
    const [entry] = await tenantLog('action=member.suspended&limit=1');
    expect(entry).toMatchObject({
      actorUserId: A.adminUserId,
      actorName: 'Admin',
      actorEmail: A.adminEmail,
    });
  });

  it('is ONE query for the whole page (the actors are joined, there is no query per row)', async () => {
    for (let i = 0; i < 3; i++) {
      await owner.query(
        "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type) VALUES ($1, $2, $3, 'test.many', 'x')",
        [newId(), A.tenantId, A.adminUserId],
      );
    }
    t.statements.reset();
    const res = await admin.get('/audit', { query: 'action=test.many&limit=50' });
    expect(res.json().items).toHaveLength(3);
    const reads = t.statements.statements.filter((s) => /audit_log/i.test(s));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/LEFT JOIN lms\.users/i);
  });

  it('shows "Unknown user" for an actor who was removed from the college, and keeps the id', async () => {
    const other = await addMember(owner, A.tenantId, 'leaver@aud-a.test', {
      role: 'institution_admin',
      displayName: 'Leaver',
    });
    const victim = await addMember(owner, A.tenantId, 'victim2@aud-a.test');
    const leaver = new TestClient(t, A.host);
    expect((await leaver.login(other.email, TEST_PASSWORD)).statusCode).toBe(200);
    expect((await leaver.post(`/members/${victim.userId}/suspend`)).statusCode).toBe(200);

    const before = (await tenantLog('action=member.suspended&limit=5')).find(
      (e) => e.actorUserId === other.userId,
    );
    expect(before?.actorName).toBe('Leaver'); // while a member, the name is shown

    expect((await admin.delete(`/members/${other.userId}`)).statusCode).toBe(200);
    const after = (await tenantLog('action=member.suspended&limit=5')).find(
      (e) => e.actorUserId === other.userId,
    );
    expect(after).toMatchObject({ actorName: 'Unknown user', actorEmail: null });
  });

  it('a system action has no actor at all (null), not "Unknown user"', async () => {
    await owner.query(
      "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type) VALUES ($1, $2, NULL, 'test.system', 'x')",
      [newId(), A.tenantId],
    );
    const [entry] = await tenantLog('action=test.system&limit=1');
    expect(entry).toMatchObject({ actorUserId: null, actorName: null, actorEmail: null });
  });

  it('a platform admin acting inside the college is named as such (they are not a member)', async () => {
    await owner.query(
      `INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, metadata)
       VALUES ($1, $2, $3, 'test.via_platform', 'x', '{"viaPlatformAdmin": true}')`,
      [newId(), A.tenantId, rootUserId],
    );
    const [entry] = await tenantLog('action=test.via_platform&limit=1');
    expect(entry).toMatchObject({ actorUserId: rootUserId, actorName: 'Platform administrator' });
  });

  it("never shows another college's people", async () => {
    const B = await createAuthFixture(owner, 'aud-b');
    await owner.query(
      "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type) VALUES ($1, $2, $3, 'test.foreign', 'x')",
      [newId(), A.tenantId, B.adminUserId], // an actor that belongs to college B, logged in college A
    );
    const [entry] = await tenantLog('action=test.foreign&limit=1');
    expect(entry).toMatchObject({
      actorUserId: B.adminUserId,
      actorName: 'Unknown user',
      actorEmail: null,
    });
  });
});

describe('GET /platform/audit: who did it', () => {
  it('returns the name and email of the platform admin', async () => {
    const created = await root.post('/platform/tenants', {
      name: 'Aud Co',
      slug: 'aud-co',
      adminEmail: 'first@aud-co.test',
      adminName: 'First',
    });
    expect(created.statusCode).toBe(201);
    const log = (
      await root.get('/platform/audit', { query: 'action=platform.tenant_created&limit=1' })
    ).json();
    expect(log.items[0]).toMatchObject({
      actorUserId: rootUserId,
      actorName: 'Root',
      actorEmail: 'root@audit-actors.test',
    });
  });
});
