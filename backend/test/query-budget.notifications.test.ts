import { generateKeyPairSync, sign } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { loginAs, type Person, person } from './courses-helpers';
import { quietOff } from './notifications-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// QUERY BUDGETS of Step 13 (see query-budget.test.ts for the rules). The bell is the session lookup + ONE definer call = 2
// (a 304 costs the same: the ETag is computed from the count). The member's list / mark read / preferences are the lookup +
// one transaction with ONE statement = 4; settings PATCH 5 (read, merge, write: a rare admin action). Suppressions and the
// platform inbox are one definer call = 2. Public unsubscribe calls have no session: the slug is cached, ONE call = 1. The
// provider webhook (no college, no session): 1. Sending happens in the worker, never in a request.

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let root: TestClient;
let p: Person;

async function measure(fn: () => Promise<unknown>): Promise<string[]> {
  t.statements.reset();
  await fn();
  await t.app.modules.background.drain();
  return t.statements.statements;
}
const run = async (
  name: string,
  fn: () => Promise<{ statusCode: number; body: string }>,
  max: number,
) => {
  const s = await measure(async () => {
    const r = await fn();
    expect(r.statusCode, `${name}: ${r.body}`).toBeLessThan(400);
  });
  const listing = s.map((x) => x.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ');
  process.stdout.write(`ROUND-TRIPS ${name}: ${s.length} (budget ${max})\n`);
  expect(s.length, `${name} used ${s.length} round trips:\n  ${listing}`).toBeLessThanOrEqual(max);
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({
    env: {
      TENANT_CACHE_TTL_MS: '3600000',
      SENDGRID_WEBHOOK_PUBLIC_KEY: publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
    },
  });
  A = await createAuthFixture(owner, 'ntf-bud');
  const plat = await createPlatformAdmin(owner, 'root@ntfbud.test');
  await t.app.ready();
  await quietOff(owner, A.tenantId);
  admin = await loginAs(t, A.host, A.adminEmail);
  root = new TestClient(t, 'admin.localhost');
  expect((await root.login(plat.email, TEST_PASSWORD)).statusCode).toBe(200);
  p = await person(owner, t, A, 'Budget');
  await owner.query(
    `INSERT INTO lms.notifications (id, tenant_id, user_id, category, type, params, dedupe_key)
     SELECT lms.uuid_v7(), $1, $2, 'learning_content', 'content_digest', '{}', 'b:' || g FROM generate_series(1, 30) g`,
    [A.tenantId, p.userId],
  );
  // warm: slug cache, the activity cache of every caller
  for (const c of [p.client, admin]) await c.get('/notifications');
  await new TestClient(t, A.host).get('/tenant/info');
  await t.app.modules.background.drain();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('the member', () => {
  it('the bell: 2, also as a 304', async () => {
    await run(
      'GET /notifications/unread-count',
      () => p.client.get('/notifications/unread-count'),
      2,
    );
    const etag = (await p.client.get('/notifications/unread-count')).headers.etag as string;
    await run(
      'GET /notifications/unread-count (304)',
      () => p.client.get('/notifications/unread-count', { headers: { 'if-none-match': etag } }),
      2,
    );
  });
  it('list, mark read, read all, preferences (read and write): 4', async () => {
    await run('GET /notifications', () => p.client.get('/notifications?limit=20'), 4);
    const id = (await p.client.get('/notifications?limit=1')).json().items[0].id;
    await run('POST /notifications/:id/read', () => p.client.post(`/notifications/${id}/read`), 4);
    await run('POST /notifications/read-all', () => p.client.post('/notifications/read-all'), 4);
    await run(
      'GET /me/notification-preferences',
      () => p.client.get('/me/notification-preferences'),
      4,
    );
    await run(
      'PUT /me/notification-preferences',
      () =>
        p.client.put('/me/notification-preferences', {
          category: 'learning_content',
          email: false,
          inApp: true,
        }),
      4,
    );
  });
  it('my email status (the banner): 2', async () => {
    await run('GET /me/email-status', () => p.client.get('/me/email-status'), 2);
  });
});

describe('the college', () => {
  it('settings: read 4, write 5; suppressions: 2', async () => {
    await run('GET /notifications/settings', () => admin.get('/notifications/settings'), 4);
    await run(
      'PATCH /notifications/settings',
      () => admin.patch('/notifications/settings', { digestHour: 8 }),
      5,
    );
    await run('GET /email/suppressions', () => admin.get('/email/suppressions'), 2);
    await owner.query(
      `INSERT INTO lms.email_suppressions (id, email, reason) VALUES (lms.uuid_v7(), $1, 'bounce')`,
      [p.email],
    );
    const id = (await admin.get('/email/suppressions')).json().items[0].id;
    await run('DELETE /email/suppressions/:id', () => admin.delete(`/email/suppressions/${id}`), 2);
  });
});

describe('public: unsubscribe and the provider webhook', () => {
  it('unsubscribe info / page POST / one-click: 1 each (no session; the slug is cached)', async () => {
    const token = t.app.modules.notifications.unsubscribe.sign({
      tenantId: A.tenantId,
      userId: p.userId,
      category: 'learning_grades',
    });
    const anon = new TestClient(t, A.host);
    await run(
      'GET /notifications/unsubscribe',
      () => anon.get(`/notifications/unsubscribe?t=${token}`),
      1,
    );
    await run(
      'POST /notifications/unsubscribe',
      () => anon.post('/notifications/unsubscribe', { token }),
      1,
    );
    await run(
      'POST /notifications/unsubscribe/one-click',
      () =>
        t.app.inject({
          method: 'POST',
          url: `/api/notifications/unsubscribe/one-click?t=${token}`,
          headers: { host: A.host, 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'List-Unsubscribe=One-Click',
        }),
      1,
    );
  });
  it('the signed webhook: 1', async () => {
    const raw = JSON.stringify([{ sg_event_id: 'bud-1', event: 'delivered', email: p.email }]);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign('sha256', Buffer.from(ts + raw), {
      key: privateKey,
      dsaEncoding: 'der',
    }).toString('base64');
    await run(
      'POST /email/webhooks/:provider',
      () =>
        t.app.inject({
          method: 'POST',
          url: '/api/email/webhooks/sendgrid',
          headers: {
            host: 'localhost',
            'content-type': 'application/json',
            'x-twilio-email-event-webhook-signature': sig,
            'x-twilio-email-event-webhook-timestamp': ts,
          },
          payload: raw,
        }),
      1,
    );
  });
});

describe('platform admins', () => {
  it('inbox, bell, suppressions, sender: 2 each', async () => {
    await run('GET /platform/notifications', () => root.get('/platform/notifications'), 2);
    await run(
      'GET /notifications/unread-count (admin host)',
      () => root.get('/notifications/unread-count'),
      2,
    );
    await run(
      'POST /platform/notifications/read',
      () => root.post('/platform/notifications/read', {}),
      2,
    );
    await run(
      'GET /platform/email/suppressions',
      () => root.get('/platform/email/suppressions'),
      2,
    );
    await run(
      'PUT /platform/tenants/:id/email-sender',
      () => root.put(`/platform/tenants/${A.tenantId}/email-sender`, { fromAddress: null }),
      2,
    );
  });
});

describe('events add no round trip to the requests that cause them', () => {
  it('an invite is the same statements as before step 13 minus the token (the audit trigger queues the email)', async () => {
    await run(
      'POST /auth/invites',
      () => admin.post('/auth/invites', { email: 'budget-invite@ntf-bud.test', role: 'member' }),
      9,
    );
  });
});
