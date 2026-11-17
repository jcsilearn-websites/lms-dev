import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { errorCode, loginAs, ok, type Person, person } from './courses-helpers';
import { notificationsOf, outboxOf, quietOff } from './notifications-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// Step 13: the in-app side. The member's own list (keyset), the bell (count capped at 100, ETag / 304), mark read, preferences
// per category and channel with college defaults (security mandatory, changes effective at once), college settings (audited),
// retention, the platform admins' inbox.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'ntf-api');
  await t.app.ready();
  await quietOff(owner, A.tenantId);
  admin = await loginAs(t, A.host, A.adminEmail);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** One event for `p` through the real fan-out. */
async function notify(p: { userId: string }, key: string, category = 'learning_grades') {
  await owner.query(
    `SELECT lms.notify_fanout(ARRAY[ROW($1::uuid, $2::uuid, $3::text, 'grade_released',
       jsonb_build_object('course', 'Maths', 'item', 'Quiz ' || $4, 'kind', 'assessment', 'hasFeedback', false),
       '/offerings/o/attempts/a/result', $4::text, 'grade_released', NULL::timestamptz, true)::lms.notify_item])`,
    [A.tenantId, p.userId, category, key],
  );
}

describe('the list and the bell', () => {
  let p: Person;
  it("lists the member's own notifications newest first, in keyset pages, with an unread filter", async () => {
    p = await person(owner, t, A, 'Reader');
    for (const k of ['k1', 'k2', 'k3']) await notify(p, k);
    const first = ok(await p.client.get('/notifications?limit=2'));
    expect(first.items.map((x: { params: { item: string } }) => x.params.item)).toEqual([
      'Quiz k3',
      'Quiz k2',
    ]);
    expect(first.nextCursor).toBe(first.items[1].id);
    const second = ok(await p.client.get(`/notifications?limit=2&after=${first.nextCursor}`));
    expect(second.items.map((x: { params: { item: string } }) => x.params.item)).toEqual([
      'Quiz k1',
    ]);
    expect(second.nextCursor).toBeNull();
    // somebody else sees none of them
    const other = await person(owner, t, A, 'Other');
    expect(ok(await other.client.get('/notifications')).items).toEqual([]);
    expect(ok(await admin.get('/notifications')).items).toEqual([]);
  });

  it('the bell: unread count with an ETag; the same ETag answers 304; a new notification changes it', async () => {
    const r1 = await p.client.get('/notifications/unread-count');
    expect(r1.json()).toEqual({ unread: 3 });
    const etag = r1.headers.etag as string;
    expect(etag).toMatch(/^W\/"3\./);
    expect(r1.headers['cache-control']).toBe('private, no-cache');
    const r2 = await p.client.get('/notifications/unread-count', {
      headers: { 'if-none-match': etag },
    });
    expect(r2.statusCode).toBe(304);
    expect(r2.body).toBe('');
    await notify(p, 'k4');
    const r3 = await p.client.get('/notifications/unread-count', {
      headers: { 'if-none-match': etag },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json()).toEqual({ unread: 4 });
  });

  it("mark one read (only one's own), mark all read", async () => {
    const list = ok(await p.client.get('/notifications'));
    const id = list.items[0].id;
    const other = await person(owner, t, A, 'Intruder');
    expect(ok(await other.client.post(`/notifications/${id}/read`))).toEqual({ updated: 0 });
    expect(ok(await p.client.post(`/notifications/${id}/read`))).toEqual({ updated: 1 });
    expect(ok(await p.client.post(`/notifications/${id}/read`))).toEqual({ updated: 0 });
    expect(ok(await p.client.get('/notifications/unread-count')).unread).toBe(3);
    expect(ok(await p.client.get('/notifications?unread=true')).items).toHaveLength(3);
    expect(ok(await p.client.post('/notifications/read-all'))).toEqual({ updated: 3 });
    expect(ok(await p.client.get('/notifications/unread-count')).unread).toBe(0);
  });

  it('the count is capped at 100 ("99+")', async () => {
    const q = await person(owner, t, A, 'Busy');
    await owner.query(
      `INSERT INTO lms.notifications (id, tenant_id, user_id, category, type, params, dedupe_key)
       SELECT lms.uuid_v7(), $1, $2, 'learning_content', 'content_digest', '{}', 'bulk:' || g FROM generate_series(1, 130) g`,
      [A.tenantId, q.userId],
    );
    expect(ok(await q.client.get('/notifications/unread-count')).unread).toBe(100);
  });
});

describe('preferences', () => {
  it('every category with the college default; security is mandatory (409); a change is effective at once', async () => {
    const p = await person(owner, t, A, 'Prefs');
    const prefs = ok(await p.client.get('/me/notification-preferences'));
    expect(prefs.items.map((x: { category: string }) => x.category)).toEqual([
      'security',
      'learning_deadlines',
      'learning_grades',
      'learning_content',
      'teaching_grading',
      'teaching_updates',
      'admin',
    ]);
    expect(prefs.items[0]).toMatchObject({ mandatory: true, email: true, inApp: true });
    const sec = await p.client.put('/me/notification-preferences', {
      category: 'security',
      email: false,
      inApp: false,
    });
    expect(sec.statusCode).toBe(409);
    expect(errorCode(sec)).toBe('category_mandatory');

    const off = ok(
      await p.client.put('/me/notification-preferences', {
        category: 'learning_grades',
        email: false,
        inApp: false,
      }),
    );
    expect(
      off.items.find((x: { category: string }) => x.category === 'learning_grades'),
    ).toMatchObject({
      email: false,
      inApp: false,
      overridden: true,
    });
    await notify(p, 'after-off');
    expect(await notificationsOf(owner, p.userId)).toEqual([]);
    expect(await outboxOf(owner, { userId: p.userId })).toEqual([]);
    // email only
    ok(
      await p.client.put('/me/notification-preferences', {
        category: 'learning_grades',
        email: true,
        inApp: false,
      }),
    );
    await notify(p, 'email-only');
    expect(await notificationsOf(owner, p.userId)).toEqual([]);
    expect(await outboxOf(owner, { userId: p.userId })).toHaveLength(1);
  });

  it('an email already queued is skipped when the member switches the category off before it is sent', async () => {
    const p = await person(owner, t, A, 'Late');
    await notify(p, 'queued-then-off');
    ok(
      await p.client.put('/me/notification-preferences', {
        category: 'learning_grades',
        email: false,
        inApp: true,
      }),
    );
    const { deliverEmails } = await import('./client');
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === p.email)).toEqual([]);
    expect((await outboxOf(owner, { userId: p.userId }))[0]).toMatchObject({
      status: 'skipped',
      skip_reason: 'preference_or_membership',
    });
  });

  it("college defaults (institution admins, audited) apply to members who chose nothing; a member's choice wins", async () => {
    const chose = await person(owner, t, A, 'Chooser');
    ok(
      await chose.client.put('/me/notification-preferences', {
        category: 'learning_content',
        email: true,
        inApp: true,
      }),
    );
    const s = ok(
      await admin.patch('/notifications/settings', {
        defaults: { learning_content: { email: false, inApp: true } },
        digestHour: 6,
        quietHours: { enabled: false, start: '21:30', end: '06:30' },
        fromName: 'JCS College of Arts',
        replyTo: 'office@college.example.edu',
      }),
    );
    expect(s).toMatchObject({
      digestHour: 6,
      fromName: 'JCS College of Arts',
      replyTo: 'office@college.example.edu',
      fromAddress: null,
      timeZone: 'Asia/Kolkata',
      defaults: {
        learning_content: { email: false, inApp: true },
        learning_grades: { email: true, inApp: true },
      },
    });
    const fresh = await person(owner, t, A, 'Fresh');
    const fp = ok(await fresh.client.get('/me/notification-preferences')).items.find(
      (x: { category: string }) => x.category === 'learning_content',
    );
    expect(fp).toMatchObject({
      email: false,
      inApp: true,
      overridden: false,
      collegeDefault: { email: false, inApp: true },
    });
    const cp = ok(await chose.client.get('/me/notification-preferences')).items.find(
      (x: { category: string }) => x.category === 'learning_content',
    );
    expect(cp).toMatchObject({ email: true, overridden: true });
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'notification.settings_updated' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0].metadata.after.digestHour).toBe(6);
    expect(rows[0].metadata.before.digestHour).toBe(7);
    // members cannot read or change the college's settings
    expect((await fresh.client.get('/notifications/settings')).statusCode).toBe(403);
    expect(
      (await fresh.client.patch('/notifications/settings', { digestHour: 1 })).statusCode,
    ).toBe(403);
    // validation
    expect((await admin.patch('/notifications/settings', { digestHour: 24 })).statusCode).toBe(400);
    expect(
      (
        await admin.patch('/notifications/settings', {
          quietHours: { enabled: true, start: '25:00', end: '07:00' },
        })
      ).statusCode,
    ).toBe(400);
    ok(
      await admin.patch('/notifications/settings', {
        defaults: { learning_content: { email: true, inApp: true } },
      }),
    );
    await quietOff(owner, A.tenantId);
  });
});

describe('retention', () => {
  it('read notifications older than the retention are purged; unread ones are kept', async () => {
    const p = await person(owner, t, A, 'Purge');
    await notify(p, 'old-read');
    await notify(p, 'old-unread');
    await owner.query(
      `UPDATE lms.notifications SET created_at = now() - interval '400 days',
              read_at = CASE WHEN dedupe_key = 'old-read' THEN now() - interval '400 days' END
        WHERE user_id = $1`,
      [p.userId],
    );
    expect(await t.app.modules.notifications.service.purgeRead()).toBeGreaterThanOrEqual(1);
    expect((await notificationsOf(owner, p.userId)).map((n) => n.dedupe_key)).toEqual([
      'old-unread',
    ]);
  });
});

describe('platform admins', () => {
  it('have their own inbox on the admin host; the bell works there too', async () => {
    const root = await createPlatformAdmin(owner, 'inbox-root@ntf.test');
    const c = new TestClient(t, 'admin.localhost');
    await c.login(root.email, TEST_PASSWORD);
    await owner.query(
      `INSERT INTO lms.platform_notifications (id, user_id, type, params, link, dedupe_key)
       VALUES (lms.uuid_v7(), $1, 'usage_closed', '{"month":"2026-10-01","colleges":3}', '/usage', 'u1')`,
      [root.userId],
    );
    expect(ok(await c.get('/notifications/unread-count')).unread).toBe(1);
    const list = ok(await c.get('/platform/notifications'));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      type: 'usage_closed',
      category: 'admin',
      link: '/usage',
    });
    expect(ok(await c.post('/platform/notifications/read', {}))).toEqual({ updated: 1 });
    expect(ok(await c.get('/notifications/unread-count')).unread).toBe(0);
    // tenant-host member endpoints are not theirs
    expect((await c.get('/notifications')).statusCode).toBe(403);
  });
});
