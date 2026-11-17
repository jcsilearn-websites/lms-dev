import { generateKeyPairSync, sign } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmailSendError } from '../src/core/mail';
import { makeApp, type TestApp } from './app';
import { deliverEmails, TestClient } from './client';
import { errorCode, loginAs, ok, type Person, person } from './courses-helpers';
import { addMember } from './fixtures';
import { outboxOf, quietOff } from './notifications-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// Step 13: the outbox and its worker. No double sends on retry, retries with backoff and a dead letter, a permanent refusal
// is final, suppressed addresses get nothing (bounce: nothing at all; complaint: security mail only), the signed provider
// webhook, one-click unsubscribe (valid / forged / expired / security refused / GET changes nothing), the member's banner,
// the admins' path to clear it, the From address.

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({
    env: {
      TENANT_CACHE_TTL_MS: '3600000',
      SENDGRID_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY,
      EMAIL_FROM_DEFAULT: 'no-reply@notify.example.test',
    },
  });
  A = await createAuthFixture(owner, 'mail-d');
  await t.app.ready();
  await quietOff(owner, A.tenantId);
  admin = await loginAs(t, A.host, A.adminEmail);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** A non-security email for `p` through the real fan-out (the same function every event uses). */
async function digestFor(p: Person, key: string) {
  await owner.query(
    `SELECT lms.notify_fanout(ARRAY[ROW($1::uuid, $2::uuid, 'learning_content', 'content_digest',
       jsonb_build_object('course', 'Physics', 'count', 1, 'titles', jsonb_build_array('Lab 1')),
       '/offerings/x', $3::text, 'content_digest', NULL::timestamptz, true)::lms.notify_item])`,
    [A.tenantId, p.userId, key],
  );
}

const forgot = (email: string) =>
  new TestClient(t, A.host).post('/auth/password/forgot', { email });

describe('idempotency and retries', () => {
  it('the same event twice is ONE outbox row and ONE email', async () => {
    const p = await person(owner, t, A, 'Twice');
    await digestFor(p, 'dup-key-1');
    await digestFor(p, 'dup-key-1');
    expect(await outboxOf(owner, { userId: p.userId })).toHaveLength(1);
    await deliverEmails(t);
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === p.email)).toHaveLength(1);
  });

  it('a provider failure is retried with backoff and sent ONCE; a finished row is never sent again', async () => {
    const p = await person(owner, t, A, 'Retry');
    await digestFor(p, 'retry-1');
    t.mailer.failNext(1, new Error('connection reset'));
    await deliverEmails(t);
    let [row] = await outboxOf(owner, { userId: p.userId });
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(t.mailer.sent.filter((m) => m.to === p.email)).toHaveLength(0);
    // the job waits for its backoff: make it due, then run it again
    await owner.query(
      `UPDATE lms.jobs SET run_at = now() WHERE payload ->> 'outboxId' = $1 AND status = 'queued'`,
      [row?.id],
    );
    await deliverEmails(t);
    [row] = await outboxOf(owner, { userId: p.userId });
    expect(row).toMatchObject({ status: 'sent', attempts: 2 });
    const sent = t.mailer.sent.filter((m) => m.to === p.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messageId).toBe(`<${row?.id}@notify.example.test>`);
    // a duplicate job for the same row (e.g. a re-claim after a lost lease) finds it finished and sends nothing
    await owner.query(
      `INSERT INTO lms.jobs (id, queue, tenant_id, payload) VALUES (lms.uuid_v7(), 'email.send', $1, jsonb_build_object('outboxId', $2::text))`,
      [A.tenantId, row?.id],
    );
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === p.email)).toHaveLength(1);
  });

  it('a permanent refusal is final (dead at once); the last attempt is dead too', async () => {
    const p = await person(owner, t, A, 'Perm');
    await digestFor(p, 'perm-1');
    t.mailer.failNext(1, new EmailSendError('550 mailbox unavailable', true));
    await deliverEmails(t);
    const [row] = await outboxOf(owner, { userId: p.userId });
    expect(row).toMatchObject({ status: 'dead' });
    const { rows } = await owner.query(
      `SELECT status FROM lms.jobs WHERE payload ->> 'outboxId' = $1`,
      [row?.id],
    );
    expect(rows.map((r) => r.status)).toEqual(['completed']);

    const q = await person(owner, t, A, 'Last');
    await digestFor(q, 'last-1');
    const [r2] = await outboxOf(owner, { userId: q.userId });
    await owner.query(`UPDATE lms.jobs SET max_attempts = 1 WHERE payload ->> 'outboxId' = $1`, [
      r2?.id,
    ]);
    t.mailer.failNext(1, new Error('timeout'));
    await deliverEmails(t);
    expect((await outboxOf(owner, { userId: q.userId }))[0]?.status).toBe('dead');
  });

  it('the outbox never holds a token: invite and reset tokens are minted when the email is sent', async () => {
    ok(await admin.post('/auth/invites', { email: 'fresh@mail-d.test', role: 'member' }));
    await forgot(A.memberEmail);
    await t.app.modules.background.drain();
    const { rows } = await owner.query(
      `SELECT params::text AS p FROM lms.email_outbox WHERE category = 'security'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.p).not.toMatch(/token/i);
    await deliverEmails(t);
    const invite = t.mailer.sent.find((m) => m.to === 'fresh@mail-d.test');
    expect(invite?.text).toMatch(/accept-invite\?token=[A-Za-z0-9_-]{43}/);
    expect(invite?.headers['List-Unsubscribe']).toBeUndefined();
    expect(invite?.text).toContain('It cannot be switched off.');
  });
});

describe('the From address', () => {
  it('JCS default with the college name; a verified college address once a platform admin sets it (audited)', async () => {
    const p = await person(owner, t, A, 'From');
    await digestFor(p, 'from-1');
    await deliverEmails(t);
    expect(t.mailer.sent.find((m) => m.to === p.email)?.from).toBe(
      `"Tenant mail-d via JCS iLearn" <no-reply@notify.example.test>`,
    );
    const root = await createPlatformAdmin(owner, 'sender-root@mail.test');
    const r = new TestClient(t, 'admin.localhost');
    await r.login(root.email, TEST_PASSWORD);
    expect(
      (
        await r.put(`/platform/tenants/${A.tenantId}/email-sender`, {
          fromAddress: 'LMS@College.example.edu',
        })
      ).statusCode,
    ).toBe(204);
    await digestFor(p, 'from-2');
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === p.email).at(-1)?.from).toBe(
      `"Tenant mail-d" <lms@college.example.edu>`,
    );
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.platform_audit_log WHERE action = 'platform.tenant_email_sender_set'`,
    );
    expect(rows[0].metadata).toMatchObject({ before: null, after: 'lms@college.example.edu' });
    // an institution admin cannot set it
    expect(
      (await admin.put(`/platform/tenants/${A.tenantId}/email-sender`, { fromAddress: null }))
        .statusCode,
    ).toBe(403);
    expect(
      (await r.put(`/platform/tenants/${A.tenantId}/email-sender`, { fromAddress: null }))
        .statusCode,
    ).toBe(204);
  });
});

describe('suppression list and the provider webhook', () => {
  const post = (body: unknown, opts: { sig?: string; ts?: string } = {}) => {
    const raw = JSON.stringify(body);
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const sig =
      opts.sig ??
      sign('sha256', Buffer.from(ts + raw), { key: privateKey, dsaEncoding: 'der' }).toString(
        'base64',
      );
    return t.app.inject({
      method: 'POST',
      url: '/api/email/webhooks/sendgrid',
      // no Origin, no X-Requested-With, no cookie: the provider cannot send them
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'x-twilio-email-event-webhook-signature': sig,
        'x-twilio-email-event-webhook-timestamp': ts,
      },
      payload: raw,
    });
  };

  it('refuses a forged, missing or stale signature and records nothing', async () => {
    const ev = [
      { sg_event_id: 'forged-1', event: 'bounce', type: 'bounce', email: 'victim@mail-d.test' },
    ];
    expect((await post(ev, { sig: Buffer.from('nope').toString('base64') })).statusCode).toBe(401);
    expect((await post(ev, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).statusCode).toBe(
      401,
    );
    const missing = await t.app.inject({
      method: 'POST',
      url: '/api/email/webhooks/sendgrid',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: JSON.stringify(ev),
    });
    expect(missing.statusCode).toBe(401);
    // a different body under a valid-looking signature of another body
    const ts = String(Math.floor(Date.now() / 1000));
    const sigOther = sign('sha256', Buffer.from(`${ts}[]`), {
      key: privateKey,
      dsaEncoding: 'der',
    }).toString('base64');
    expect((await post(ev, { sig: sigOther, ts })).statusCode).toBe(401);
    expect(
      (await owner.query(`SELECT 1 FROM lms.email_suppressions WHERE email = 'victim@mail-d.test'`))
        .rowCount,
    ).toBe(0);
    // an unknown provider
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/email/webhooks/nobody',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: '[]',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('a hard bounce suppresses EVERYTHING (security mail too) until an admin clears it; the member sees a banner', async () => {
    const p = await person(owner, t, A, 'Bouncy');
    const res = await post([
      {
        sg_event_id: 'b-1',
        event: 'bounce',
        type: 'bounce',
        email: p.email,
        reason: '550 5.1.1 user unknown',
        timestamp: 1,
      },
      { sg_event_id: 'd-1', event: 'delivered', email: p.email },
      { sg_event_id: 'blk-1', event: 'bounce', type: 'blocked', email: 'other@mail-d.test' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 3 });
    // replayed: a no-op
    expect(
      (
        await post([{ sg_event_id: 'b-1', event: 'bounce', type: 'bounce', email: p.email }])
      ).json(),
    ).toEqual({ received: 0 });
    // a temporary block is not a dead address
    expect(
      (await owner.query(`SELECT 1 FROM lms.email_suppressions WHERE email = 'other@mail-d.test'`))
        .rowCount,
    ).toBe(0);

    // the banner
    expect(ok(await p.client.get('/me/email-status'))).toMatchObject({
      email: p.email,
      suppressed: true,
      reason: 'bounce',
    });
    // nothing is queued or sent to the address, not even security mail
    await digestFor(p, 'sup-1');
    await forgot(p.email);
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === p.email)).toEqual([]);

    // the college admin sees it (their member) and clears it: audited, mail flows again
    const list = ok(await admin.get('/email/suppressions'));
    const entry = list.items.find((x: { email: string }) => x.email === p.email);
    expect(entry).toMatchObject({ reason: 'bounce', displayName: 'Bouncy', detail: 'bounce' });
    expect((await p.client.get('/email/suppressions')).statusCode).toBe(403);
    expect((await admin.delete(`/email/suppressions/${entry.id}`)).statusCode).toBe(204);
    expect((await admin.delete(`/email/suppressions/${entry.id}`)).statusCode).toBe(404);
    expect(ok(await p.client.get('/me/email-status')).suppressed).toBe(false);
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'email.suppression_cleared' AND target_id = $1`,
      [p.userId],
    );
    expect(rows).toHaveLength(1);
    await forgot(p.email);
    await deliverEmails(t);
    expect(t.mailer.sent.some((m) => m.to === p.email && m.subject === 'Reset your password')).toBe(
      true,
    );
  });

  it('a complaint stops everything but security mail', async () => {
    const p = await person(owner, t, A, 'Complainer');
    expect(
      (await post([{ sg_event_id: 'c-1', event: 'spamreport', email: p.email }])).statusCode,
    ).toBe(200);
    await digestFor(p, 'cmp-1');
    await forgot(p.email);
    await deliverEmails(t);
    const got = t.mailer.sent.filter((m) => m.to === p.email).map((m) => m.subject);
    expect(got).toEqual(['Reset your password']);
  });

  it("an admin of ANOTHER college cannot see or clear this college's suppressions", async () => {
    const B = await createAuthFixture(owner, 'mail-other');
    const bAdmin = await loginAs(t, B.host, B.adminEmail);
    const p = await person(owner, t, A, 'Private');
    expect(
      (await post([{ sg_event_id: 'priv-1', event: 'bounce', type: 'bounce', email: p.email }]))
        .statusCode,
    ).toBe(200);
    const mine = ok(await admin.get('/email/suppressions')).items.find(
      (x: { email: string }) => x.email === p.email,
    );
    expect(ok(await bAdmin.get('/email/suppressions')).items).toEqual([]);
    expect((await bAdmin.delete(`/email/suppressions/${mine.id}`)).statusCode).toBe(404);
  });
});

describe('unsubscribe (RFC 8058)', () => {
  const tokens = () => t.app.modules.notifications.unsubscribe;

  it('one-click POST from the mailbox provider (no Origin, no CSRF header, form body) switches the category off; GET changes nothing', async () => {
    const p = await person(owner, t, A, 'Unsub');
    await digestFor(p, 'u-1');
    await deliverEmails(t);
    const mail = t.mailer.sent.find((m) => m.to === p.email);
    const url = /<(http[^>]+)>/.exec(mail?.headers['List-Unsubscribe'] ?? '')?.[1] as string;
    expect(url).toContain('/api/notifications/unsubscribe/one-click?t=');
    const path = new URL(url).pathname + new URL(url).search;
    const token = new URL(url).searchParams.get('t') as string;

    // the page's GET shows what would happen and changes NOTHING (link scanners prefetch)
    const info = await t.app.inject({
      method: 'GET',
      url: `/api/notifications/unsubscribe?t=${token}`,
      headers: { host: A.host },
    });
    expect(info.json()).toMatchObject({
      category: 'learning_content',
      categoryLabel: 'New course content',
      subscribed: true,
    });
    const res = await t.app.inject({
      method: 'POST',
      url: path,
      headers: { host: A.host, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true, categoryLabel: 'New course content' });
    const prefs = ok(await p.client.get('/me/notification-preferences'));
    expect(
      prefs.items.find((x: { category: string }) => x.category === 'learning_content'),
    ).toMatchObject({
      email: false,
      inApp: true,
    });
    // the next digest: in-app yes, email no
    await digestFor(p, 'u-2');
    expect((await outboxOf(owner, { userId: p.userId })).length).toBe(1);
    // idempotent
    expect(
      (await t.app.inject({ method: 'POST', url: path, headers: { host: A.host }, payload: '' }))
        .statusCode,
    ).toBe(200);
  });

  it("forged, expired, another college's and security tokens are refused", async () => {
    const p = await person(owner, t, A, 'Forger');
    const good = tokens().sign({
      tenantId: A.tenantId,
      userId: p.userId,
      category: 'learning_grades',
    });
    const forged = `${good.slice(0, -3)}abc`;
    const expired = tokens().sign(
      { tenantId: A.tenantId, userId: p.userId, category: 'learning_grades' },
      -10,
    );
    const security = tokens().sign({
      tenantId: A.tenantId,
      userId: p.userId,
      category: 'security',
    });
    const B = await createAuthFixture(owner, 'mail-b');
    const oneClick = (token: string, host = A.host) =>
      t.app.inject({
        method: 'POST',
        url: `/api/notifications/unsubscribe/one-click?t=${token}`,
        headers: { host },
      });
    expect(errorCode(await oneClick(forged))).toBe('unsubscribe_link_invalid');
    const exp = await oneClick(expired);
    expect(exp.statusCode).toBe(400);
    expect(exp.json().error.message).toMatch(/expired/);
    expect((await oneClick(good, B.host)).statusCode).toBe(400);
    expect(errorCode(await oneClick(security))).toBe('category_mandatory');
    // the SPA's POST is NOT CSRF-exempt
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/notifications/unsubscribe',
      headers: { host: A.host, 'content-type': 'application/json' },
      payload: JSON.stringify({ token: good }),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(
      ok(await new TestClient(t, A.host).post('/notifications/unsubscribe', { token: good })),
    ).toMatchObject({
      unsubscribed: true,
    });
  });

  it("a removed member's link no longer works", async () => {
    const m = await addMember(owner, A.tenantId, 'gone@mail-d.test');
    await owner.query(`UPDATE lms.tenant_memberships SET status = 'removed' WHERE id = $1`, [
      m.membershipId,
    ]);
    const token = tokens().sign({
      tenantId: A.tenantId,
      userId: m.userId,
      category: 'learning_grades',
    });
    expect(
      (await new TestClient(t, A.host).post('/notifications/unsubscribe', { token })).statusCode,
    ).toBe(404);
  });
});

describe('retention', () => {
  it('finished outbox rows older than the retention are purged in batches; queued ones never', async () => {
    const p = await person(owner, t, A, 'Old');
    await digestFor(p, 'old-1');
    await digestFor(p, 'old-2');
    await deliverEmails(t);
    await digestFor(p, 'old-3'); // still queued
    await owner.query(
      `UPDATE lms.email_outbox SET created_at = now() - interval '400 days' WHERE user_id = $1`,
      [p.userId],
    );
    const deleted = await t.app.modules.email.service.purge();
    expect(deleted).toBeGreaterThanOrEqual(2);
    const left = await outboxOf(owner, { userId: p.userId });
    expect(left.map((r) => r.status)).toEqual(['queued']);
  });
});
