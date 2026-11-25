import { createHmac, hkdfSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reapplyErasures } from '../src/cli/privacy-reapply-erasures';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp, testEnv } from './app';
import { deliverEmails, TestClient } from './client';
import { type Json, loginAs, ok, type Person, person, runSync, structure } from './courses-helpers';
import {
  assignment,
  type Class,
  gradebookClass,
  participantIds,
  quiz,
  releaseQuiz,
} from './gradebook-helpers';
import { csv, FACULTY_HEADER, upload } from './imports-helpers';
import { approveGradebook, whereStored } from './privacy-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// DATA PROTECTION, step 14b-1 part 4: WHAT THE ERASURE OF AN ACCOUNT DOES.
// A person who was a member of TWO colleges (a class in each, a profile, sessions, mail, a suppressed address, staged import rows, audit rows in
// both, a password-reset token, a platform audit row) is removed from both and erased by a platform administrator. Then: every item of the
// account checklist (one test each), the academic record untouched (byte for byte), OTHER people unchanged (a bystander in both colleges, the
// whole global tables except the person), the sentinel sweep over every GET route as administrator, instructor and learner IN EACH college,
// the database-wide scan with the allowed places listed, and the ledger: restore an older state, re-apply, erased again.

const KEYS = `k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`;

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let adminA: TestClient;
let adminB: TestClient;
let p1: TestClient;
let p2: TestClient;
let eA: Class;
let eB: Class;
let ledgerDir: string;
const routes: { method: string; url: string }[] = [];
const svc = () => t.app.modules.privacy.erasureService;
const envOverrides = () => ({
  RATE_LIMIT_MAX: '1000000',
  RATE_LIMIT_LOGIN_PER_IP: '100000',
  RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
  LOGIN_MAX_ATTEMPTS: '50',
  DATA_EXPORT_RATE_PER_HOUR: '100000',
  TENANT_CACHE_TTL_MS: '3600000',
  ERASURE_LEDGER_DIR: ledgerDir,
  SUPPRESSION_HASH_KEYS: KEYS,
});

beforeAll(async () => {
  owner = testOwnerPool(6);
  ledgerDir = await mkdtemp(join(tmpdir(), 'lms-ledger-accx-'));
  t = makeApp({ env: envOverrides() });
  t.app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/docs') || route.schema?.hide === true) return;
    if (!route.url.startsWith('/api/')) return;
    for (const m of Array.isArray(route.method) ? route.method : [route.method])
      if (m === 'GET') routes.push({ method: m, url: route.url });
  });
  A = await createAuthFixture(owner, 'ax-a');
  B = await createAuthFixture(owner, 'ax-b');
  const pa = await createPlatformAdmin(owner, 'root1@ax.test');
  const pb = await createPlatformAdmin(owner, 'root2@ax.test');
  await t.app.ready();
  adminA = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  p1 = await loginAs(t, 'admin.localhost', pa.email);
  p2 = await loginAs(t, 'admin.localhost', pb.email);
  eA = await gradebookClass(owner, t, A, adminA, await structure(adminA), [
    'Plain Pat',
    'Plain Quin',
  ]);
  eB = await gradebookClass(owner, t, B, adminB, await structure(adminB), [
    'Plain Rae',
    'Plain Sol',
  ]);
}, 240_000);

afterAll(async () => {
  await t.close();
  await owner.end();
  await rm(ledgerDir, { recursive: true, force: true });
});

const hashOf = (address: string, secret: string) =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', secret, '', 'lms.suppression-hash', 32)))
    .update(address.trim().toLowerCase())
    .digest('hex');
const n1 = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await owner.query(sql, p)).rows[0].n);
const rowsOf = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;

// ------------------------------------------------------------------------------------------------------------------ a person with a little of everything
interface Seed {
  m: Person;
  tokens: string[];
  registerNumber: string;
  membershipA: string;
  membershipB: string;
  sessions: TestClient[];
  outbox: { id: string; tenantId: string; status: string }[];
  eventId: string;
  importId: string;
  auditIds: string[];
  platformAuditIds: string[];
  authTokenId: string;
  participants: string[];
  requestId: string;
}

let counter = 0;
async function seedPerson(label: string): Promise<Seed> {
  const n = ++counter;
  const name = `ZQ${label}${n} Vale`;
  const m = await person(owner, t, A, name);
  const registerNumber = `ZQREG${n}X`;
  const phone = `+91 98765 5${String(n).padStart(4, '0')}`;
  const membershipA = m.membershipId;
  const membershipB = newId();
  await owner.query(
    "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')",
    [membershipB, B.tenantId, m.userId],
  );
  ok(
    await adminA.post(`/offerings/${eA.offeringId}/participants`, {
      userId: m.userId,
      participation: 'learner',
    }),
  );
  ok(
    await adminB.post(`/offerings/${eB.offeringId}/participants`, {
      userId: m.userId,
      participation: 'learner',
    }),
  );
  const onB = new TestClient(t, B.host);
  expect((await onB.login(m.email, TEST_PASSWORD)).statusCode).toBe(200);
  const secondA = new TestClient(t, A.host);
  expect((await secondA.login(m.email, TEST_PASSWORD)).statusCode).toBe(200);
  await m.client.get('/auth/me');
  // mail in both colleges (one queued, one sent), a provider event, a suppressed address
  const outbox: Seed['outbox'] = [];
  for (const [tenantId, status] of [
    [A.tenantId, 'queued'],
    [A.tenantId, 'sent'],
    [B.tenantId, 'queued'],
  ] as const) {
    const id = newId();
    outbox.push({ id, tenantId, status });
    await owner.query(
      `INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params, status)
       VALUES ($1, $2, $3, $4, $5, 'learning_content', 'content_digest', '{"course":"C","count":1,"titles":["x"],"link":"/offerings/o"}', $6)`,
      [id, tenantId, `seed:${id}`, m.userId, m.email, status],
    );
  }
  const eventId = `evt-${newId()}`;
  await owner.query(
    "INSERT INTO lms.email_events (provider, event_id, kind, email, outbox_id, received_at) VALUES ('test', $1, 'delivered', $2, $3, now())",
    [eventId, m.email, outbox[1]?.id],
  );
  await owner.query(
    "INSERT INTO lms.email_suppressions (id, email, reason) VALUES ($1, $2, 'bounce')",
    [newId(), m.email],
  );
  const importId = ok(
    await upload(adminA, 'faculty', csv(FACULTY_HEADER, [[m.email, name, `EMP-ZQ${n}`, 'NOPE']])),
  ).id as string;
  // a student profile in A (register number + phone), a bell and preferences in B
  ok(
    await adminA.patch(`/members/${m.userId}/profile`, {
      profileType: 'student',
      registerNumber,
      batchId: (
        await rowsOf('SELECT id FROM lms.batches WHERE tenant_id = $1 LIMIT 1', [A.tenantId])
      )[0].id,
      sectionId: (
        await rowsOf('SELECT id FROM lms.sections WHERE tenant_id = $1 LIMIT 1', [A.tenantId])
      )[0].id,
      phone,
    }),
  );
  await owner.query(
    "INSERT INTO lms.notifications (id, tenant_id, user_id, category, type, params, dedupe_key) VALUES ($1, $2, $3, 'learning_content', 'content_digest', '{}', $4)",
    [newId(), B.tenantId, m.userId, `b:${newId()}`],
  );
  // audit rows with the address in both colleges, a platform audit row about them and one made BY them
  const auditIds = [newId(), newId()];
  for (const [id, tenantId] of [
    [auditIds[0], A.tenantId],
    [auditIds[1], B.tenantId],
  ] as const)
    await owner.query(
      `INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'test.about_person', 'user', $4, jsonb_build_object('email', $5::text, 'ip', '10.9.9.9', 'keep', 'yes'))`,
      [id, tenantId, tenantId === A.tenantId ? A.adminUserId : B.adminUserId, m.userId, m.email],
    );
  const platformAuditIds = [newId(), newId()];
  await owner.query(
    `INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip) VALUES
       ($1, NULL, 'test.about_person', 'user', $3, jsonb_build_object('email', $4::text, 'ip', '10.3.3.3', 'keep', 'yes'), '10.3.3.3'),
       ($2, $5, 'test.by_person', 'x', 'y', '{"keep":"yes"}', '10.4.4.4')`,
    [platformAuditIds[0], platformAuditIds[1], m.userId, m.email, m.userId],
  );
  const authTokenId = newId();
  await owner.query(
    "INSERT INTO lms.auth_tokens (id, purpose, token_hash, user_id, tenant_id, expires_at) VALUES ($1, 'password_reset', decode(md5($2) || md5($3), 'hex'), $4, $5, now() + interval '1 day')",
    [authTokenId, `a${authTokenId}`, `b${authTokenId}`, m.userId, A.tenantId],
  );
  // an academic record in A: a quiz and an assignment released, a locked gradebook freezing the name and register number
  await runSync(t, A.tenantId);
  const pidA = (await participantIds(owner, eA.offeringId, [m]))[0] as string;
  const pidB = (await participantIds(owner, eB.offeringId, [m]))[0] as string;
  const q1 = await quiz(eA, `Quiz ${n}`, [true, false]);
  await releaseQuiz(eA, q1.id);
  await assignment(owner, eA, `Essay ${n}`, [80, 65], { release: true, dueInPast: true });
  // (a gradebook locks once: the first person freezes it, the others are only in the class)
  if (n === 1) await approveGradebook(eA, adminA, pidA);
  // removed from both colleges by the administrators (the soft removal), never erased at college level
  ok(await adminA.delete(`/members/${m.userId}`));
  ok(await adminB.delete(`/members/${m.userId}`));
  await runSync(t, A.tenantId);
  await runSync(t, B.tenantId);
  // the request: filed by one platform administrator, approved by the other, due
  const requestId = ok(await p1.post('/platform/account-erasures', { email: m.email })).request
    .id as string;
  ok(await p2.post(`/platform/account-erasures/${requestId}/approve`, {}));
  await owner.query(
    "UPDATE lms.account_erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
    [requestId],
  );
  return {
    m,
    tokens: [
      `zq${label.toLowerCase()}${n}`,
      m.email.toLowerCase(),
      registerNumber.toLowerCase(),
      phone.slice(4),
    ],
    registerNumber,
    membershipA,
    membershipB,
    sessions: [m.client, secondA, onB],
    outbox,
    eventId,
    importId,
    auditIds,
    platformAuditIds,
    authTokenId,
    participants: [pidA, pidB],
    requestId,
  };
}

/** the academic record of the person's participants, as one hash per table (rows of the person only) */
async function recordFingerprint(s: Seed): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [table, col] of [
    ['course_participants', 'id'],
    ['item_progress', 'participant_id'],
    ['attempts', 'participant_id'],
    ['submissions', 'participant_id'],
    ['gradebook_snapshot_rows', 'participant_id'],
  ] as const)
    out[table] = (
      await owner.query(
        `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM lms.${table} x WHERE ${col} = ANY ($1)`,
        [s.participants],
      )
    ).rows[0].h;
  return out;
}

/** every row of the global tables and of both colleges that is NOT about the person (their data is the only thing an erasure may change) */
async function othersFingerprint(s: Seed, cutoff: string): Promise<Record<string, string>> {
  const uid = s.m.userId;
  const q = async (name: string, sql: string, p: unknown[] = [uid]) => {
    out[name] = (await owner.query(sql, p)).rows[0].h;
  };
  const out: Record<string, string> = {};
  await q(
    'users',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.users x WHERE id <> $1",
  );
  await q(
    'credentials',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY user_id), '')) AS h FROM lms.user_credentials x WHERE user_id <> $1",
  );
  await q(
    'memberships',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.tenant_memberships x WHERE user_id <> $1",
  );
  await q(
    'sessions',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.sessions x WHERE user_id <> $1 AND last_seen_at IS NOT NULL",
  );
  await q(
    'outbox',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.email_outbox x WHERE user_id IS DISTINCT FROM $1 AND status <> 'queued'",
  );
  await q(
    'suppressions',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.email_suppressions x WHERE email NOT LIKE '%zq%' AND email NOT LIKE '#%'",
    [],
  );
  await q(
    'overrides',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY membership_id), '')) AS h FROM lms.membership_display_overrides x WHERE membership_id <> ALL ($1)",
    [[s.membershipA, s.membershipB]],
  );
  await q(
    'profiles',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY membership_id), '')) AS h FROM lms.member_profiles x WHERE membership_id <> ALL ($1)",
    [[s.membershipA, s.membershipB]],
  );
  // (rows written after the baseline are the erasure's own and the failed sign-ins of the checks: not "other people's")
  await q(
    'audit',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.audit_log x WHERE action NOT LIKE 'privacy.%' AND created_at <= $5::timestamptz AND actor_user_id IS DISTINCT FROM $1 AND coalesce(target_id, '') NOT IN ($1::text, $2::text, $3::text) AND coalesce(metadata ->> 'userId', '') <> $1::text AND lower(coalesce(metadata ->> 'email', '')) <> $4",
    [uid, s.membershipA, s.membershipB, s.m.email.toLowerCase(), cutoff],
  );
  await q(
    'platformAudit',
    "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM lms.platform_audit_log x WHERE action NOT LIKE 'privacy.%' AND created_at <= $2::timestamptz AND actor_user_id IS DISTINCT FROM $1 AND coalesce(target_id, '') <> $1::text AND coalesce(metadata ->> 'userId', '') <> $1::text",
    [uid, cutoff],
  );
  return out;
}

/** everything the account checklist promises, for one erased person */
async function expectAccountErased(s: Seed) {
  const { m } = s;
  const u = (await rowsOf('SELECT * FROM lms.users WHERE id = $1', [m.userId]))[0];
  // 1 the global row: a pseudonym, an address that cannot receive mail, the flag
  expect(u.erased_at).not.toBeNull();
  expect(u.display_name).toMatch(/^Former user [0-9A-F]{8}$/);
  expect(u.email).toBe(`erased-${m.userId.replaceAll('-', '')}@erased.invalid`);
  // 2 no way to sign in: the credentials are gone, both addresses are refused, every session of every college is revoked and wiped
  expect(
    await n1('SELECT count(*)::int AS n FROM lms.user_credentials WHERE user_id = $1', [m.userId]),
  ).toBe(0);
  for (const host of [A.host, B.host])
    for (const email of [m.email, u.email])
      expect((await new TestClient(t, host).login(email, TEST_PASSWORD)).statusCode).toBe(401);
  const sessions = await rowsOf(
    'SELECT tenant_id, revoked_at, ip, user_agent FROM lms.sessions WHERE user_id = $1',
    [m.userId],
  );
  expect(new Set(sessions.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId, B.tenantId]));
  for (const r of sessions) expect(r).toMatchObject({ ip: null, user_agent: null });
  expect(sessions.every((r) => r.revoked_at !== null)).toBe(true);
  for (const c of s.sessions) expect((await c.get('/auth/me')).statusCode).toBe(401);
  // 3 tokens
  expect(
    await n1('SELECT count(*)::int AS n FROM lms.auth_tokens WHERE user_id = $1', [m.userId]),
  ).toBe(0);
  // 4 each college: the membership is removed and has its OWN pseudonym (the two cannot be linked), the search keys follow it
  const over = await rowsOf(
    'SELECT o.tenant_id, o.pseudonym FROM lms.membership_display_overrides o WHERE o.membership_id = ANY ($1)',
    [[s.membershipA, s.membershipB]],
  );
  expect(over).toHaveLength(2);
  expect(new Set(over.map((r) => r.pseudonym)).size).toBe(2);
  for (const r of over) expect(r.pseudonym).toMatch(/^Former member [0-9A-F]{8}$/);
  for (const k of await rowsOf(
    'SELECT status, search_name, search_email FROM lms.tenant_memberships WHERE user_id = $1',
    [m.userId],
  )) {
    expect(k.status).toBe('removed');
    expect(k.search_name).toMatch(/^former member [0-9a-f]{8}$/);
    expect(k.search_email).toBeNull();
  }
  for (const [admin, tenant] of [
    [adminA, A],
    [adminB, B],
  ] as const) {
    const items = ok(await admin.get('/members?status=removed&limit=100')).items as Json[];
    const mine = items.find((x) => x.userId === m.userId);
    expect(mine, tenant.slug).toMatchObject({ status: 'removed', email: '' });
    expect(mine?.displayName).toMatch(/^Former member [0-9A-F]{8}$/);
    // searching by the real name or address finds nobody
    for (const q of [m.email.slice(0, 8), 'zq']) {
      const found = ok(
        await admin.get(`/members?status=removed&q=${encodeURIComponent(q)}&limit=100`),
      ).items as Json[];
      expect(found.find((x) => x.userId === m.userId)).toBeUndefined();
    }
  }
  // 5 mail of both colleges: blanked, what was queued is skipped, nothing is sent to the old address
  for (const o of s.outbox) {
    const r = (
      await rowsOf(
        'SELECT status, to_email, params, skip_reason FROM lms.email_outbox WHERE id = $1',
        [o.id],
      )
    )[0];
    expect(r).toMatchObject({ to_email: 'erased.invalid', params: {} });
    if (o.status === 'queued')
      expect(r).toMatchObject({ status: 'skipped', skip_reason: 'member_erased' });
    else expect(r.status).toBe('sent');
  }
  t.mailer.sent.length = 0;
  await deliverEmails(t);
  expect(t.mailer.sent.filter((x) => x.to === m.email)).toEqual([]);
  expect(
    (await rowsOf('SELECT email FROM lms.email_events WHERE event_id = $1', [s.eventId]))[0].email,
  ).toBeNull();
  // 6 the suppression: ONLY the keyed hash is left (the plain address is replaced by a placeholder that cannot match any address)
  expect(
    await n1('SELECT count(*)::int AS n FROM lms.email_suppressions WHERE email = $1', [m.email]),
  ).toBe(0);
  const h = hashOf(m.email, 'b'.repeat(40));
  const sup = (
    await rowsOf(
      "SELECT email, email_hash_kid, encode(email_hash, 'hex') AS h FROM lms.email_suppressions WHERE email_hash = decode($1, 'hex')",
      [h],
    )
  )[0];
  expect(sup).toMatchObject({ email: `#${h}`, email_hash_kid: 'k2', h });
  // 7 staged imports, the profile, the bell / preferences / activity
  for (const r of await rowsOf(
    'SELECT email, full_name, register_number, employee_id, phone, raw FROM lms.import_rows WHERE import_id = $1',
    [s.importId],
  ))
    expect(r).toMatchObject({
      email: null,
      full_name: null,
      register_number: null,
      employee_id: null,
      phone: null,
      raw: {},
    });
  expect(
    (
      await rowsOf(
        'SELECT phone, designation, register_number, employee_id FROM lms.member_profiles WHERE membership_id = $1',
        [s.membershipA],
      )
    )[0],
  ).toEqual({
    phone: null,
    designation: null,
    register_number: null,
    employee_id: null,
  });
  for (const table of ['notifications', 'notification_preferences', 'member_activity_days'])
    expect(
      await n1(`SELECT count(*)::int AS n FROM lms.${table} WHERE user_id = $1`, [m.userId]),
    ).toBe(0);
  // 8 the audit trails: the allowlisted keys are gone, the rows, ids and other keys stay; the platform rows too
  for (const id of s.auditIds)
    expect(
      (await rowsOf('SELECT metadata FROM lms.audit_log WHERE id = $1', [id]))[0].metadata,
    ).toEqual({ keep: 'yes' });
  const pa = await rowsOf(
    'SELECT id, metadata, ip FROM lms.platform_audit_log WHERE id = ANY ($1)',
    [s.platformAuditIds],
  );
  expect(pa).toHaveLength(2);
  expect(pa.find((r) => r.id === s.platformAuditIds[0])).toMatchObject({
    metadata: { keep: 'yes' },
    ip: '10.3.3.3',
  }); // the actor's address is NOT the person's
  expect(pa.find((r) => r.id === s.platformAuditIds[1])).toMatchObject({
    metadata: { keep: 'yes' },
    ip: null,
  }); // made BY the person: their address is gone
  for (const r of await rowsOf(
    "SELECT metadata FROM lms.audit_log WHERE actor_user_id = $1 AND action LIKE 'auth.%'",
    [m.userId],
  ))
    expect(Object.keys(r.metadata)).not.toContain('ip');
  // 9 the request, its audit rows (counts only), the internal college requests
  const r = (
    await rowsOf(
      'SELECT status, executed_at, ledger_at FROM lms.account_erasure_requests WHERE id = $1',
      [s.requestId],
    )
  )[0];
  expect(r.status).toBe('done');
  expect(r.executed_at).not.toBeNull();
  const a = (
    await rowsOf(
      "SELECT metadata FROM lms.platform_audit_log WHERE action IN ('privacy.account_erasure_executed', 'privacy.account_erasure_reapplied') AND target_id = $1",
      [s.requestId],
    )
  )[0];
  expect(a.metadata).toMatchObject({
    collegesErased: expect.any(Number),
    sessionsRevoked: expect.any(Number),
    tokensDeleted: expect.any(Number),
  });
  expect(JSON.stringify(a.metadata)).not.toMatch(/zq|@/i);
  for (const tenant of [A.tenantId, B.tenantId])
    expect(
      await n1(
        "SELECT count(*)::int AS n FROM lms.audit_log WHERE tenant_id = $1 AND action IN ('privacy.erasure_executed', 'privacy.erasure_reapplied') AND target_id IN (SELECT id::text FROM lms.erasure_requests WHERE user_id = $2)",
        [tenant, m.userId],
      ),
    ).toBeGreaterThanOrEqual(1);
}

// ------------------------------------------------------------------------------------------------------------------ the checklist
describe('the account erasure satisfies its checklist, touches no academic record and no other person', () => {
  let s: Seed;
  let bystander: Person;
  let recordBefore: Record<string, string>;
  let othersBefore: Record<string, string>;
  let bystanderBefore: string;
  let membersBefore: string;
  let adminSessionBefore: number;
  let cutoff: string;

  const bystanderState = async () =>
    JSON.stringify({
      user: (await rowsOf('SELECT x FROM lms.users x WHERE id = $1', [bystander.userId]))[0],
      credentials: (
        await rowsOf(
          'SELECT md5(password_hash) AS h FROM lms.user_credentials WHERE user_id = $1',
          [bystander.userId],
        )
      )[0],
      memberships: await rowsOf(
        'SELECT x::text FROM lms.tenant_memberships x WHERE user_id = $1 ORDER BY id',
        [bystander.userId],
      ),
      outbox: await rowsOf(
        'SELECT x::text FROM lms.email_outbox x WHERE user_id = $1 ORDER BY id',
        [bystander.userId],
      ),
      audit: await rowsOf(
        'SELECT x::text FROM lms.audit_log x WHERE actor_user_id = $1 AND action NOT LIKE $2 ORDER BY id',
        [bystander.userId, 'privacy.%'],
      ),
    });

  beforeAll(async () => {
    // the other person: in both colleges, with mail and an audit row of their own, signed in on both
    bystander = await person(owner, t, A, 'Bystander Bo');
    await owner.query(
      "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')",
      [newId(), B.tenantId, bystander.userId],
    );
    await owner.query(
      "INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params, status) VALUES ($1, $2, $3, $4, $5, 'learning_content', 'content_digest', '{\"a\":1}', 'sent')",
      [newId(), B.tenantId, `by:${newId()}`, bystander.userId, bystander.email],
    );
    await owner.query(
      "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, 'test.bystander', 'x', 'y', '{\"ip\":\"10.7.7.7\"}')",
      [newId(), A.tenantId, bystander.userId],
    );
    await owner.query(
      "INSERT INTO lms.email_suppressions (id, email, reason) VALUES ($1, $2, 'bounce')",
      [newId(), bystander.email],
    );
    s = await seedPerson('Acc');
    recordBefore = await recordFingerprint(s);
    expect(Object.values(recordBefore).every((x) => typeof x === 'string')).toBe(true);
    // the things exist BEFORE: the sentinels are in the places the inventory lists (the scan has teeth)
    const stored = await whereStored(owner, s.tokens);
    for (const place of [
      'users.display_name',
      'users.email',
      'email_outbox.to_email',
      'import_rows.email',
      'member_profiles.register_number',
      'member_profiles.phone',
      'audit_log.metadata',
      'platform_audit_log.metadata',
      'email_suppressions.email',
      'gradebook_snapshot_rows.display_name',
    ])
      expect(Object.keys(stored), place).toContain(place);
    await t.app.modules.background.drain();
    cutoff = (await rowsOf('SELECT now()::text AS c'))[0].c;
    othersBefore = await othersFingerprint(s, cutoff);
    bystanderBefore = await bystanderState();
    membersBefore = JSON.stringify(
      (ok(await adminB.get('/members?limit=100')).items as Json[]).find(
        (x) => x.userId === bystander.userId,
      ),
    );
    adminSessionBefore = await n1(
      'SELECT count(*)::int AS n FROM lms.sessions WHERE revoked_at IS NULL AND user_id = $1',
      [bystander.userId],
    );
    // execute: the worker's scan (one transaction)
    const out = await svc().scan();
    expect(out.accountsErased).toBe(1);
  }, 360_000);

  it('the checklist: global row, sign-in, sessions, tokens, both colleges, mail, suppression, imports, profile, audit trails, request', async () => {
    await expectAccountErased(s);
  }, 120_000);

  it('the academic record is untouched byte for byte: enrolments, progress, attempts, submissions and the frozen gradebook (name and register number)', async () => {
    expect(await recordFingerprint(s)).toEqual(recordBefore);
    const snap = (
      await rowsOf(
        'SELECT display_name, register_number FROM lms.gradebook_snapshot_rows WHERE participant_id = $1',
        [s.participants[0]],
      )
    )[0];
    expect(snap.display_name).toContain('ZQAcc');
    expect(snap.register_number).toBe(s.registerNumber);
    // ... and it is shown under the pseudonym everywhere else: the class list of the offering
    const cls = JSON.stringify(ok(await adminA.get(`/offerings/${eA.offeringId}/participants`)));
    expect(cls.toLowerCase()).not.toContain(s.tokens[0]);
  });

  it('OTHER people are unchanged: the global tables without the person, a bystander of both colleges (rows, list entry, session)', async () => {
    await t.app.modules.background.drain();
    expect(await othersFingerprint(s, cutoff)).toEqual(othersBefore);
    expect(await bystanderState()).toBe(bystanderBefore);
    expect(
      JSON.stringify(
        (ok(await adminB.get('/members?limit=100')).items as Json[]).find(
          (x) => x.userId === bystander.userId,
        ),
      ),
    ).toBe(membersBefore);
    expect((await bystander.client.get('/auth/me')).statusCode).toBe(200);
    expect(
      await n1(
        'SELECT count(*)::int AS n FROM lms.sessions WHERE revoked_at IS NULL AND user_id = $1',
        [bystander.userId],
      ),
    ).toBe(adminSessionBefore);
    expect(
      await n1(
        'SELECT count(*)::int AS n FROM lms.email_suppressions WHERE email = $1 AND email_hash IS NULL',
        [bystander.email],
      ),
    ).toBe(1); // untouched: no hash, plain address
    expect(
      await n1(
        "SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE user_id = $1 AND status = 'active'",
        [bystander.userId],
      ),
    ).toBe(2);
  });

  it('the ledger holds ONE account entry (request, user, level, time): ids only, outside the database; the database knows it was written', async () => {
    const lines = (await readFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const mine = lines.filter((l) => l.requestId === s.requestId);
    expect(mine).toEqual([
      {
        v: 1,
        requestId: s.requestId,
        userId: s.m.userId,
        level: 'account',
        at: expect.any(String),
      },
    ]);
    const text = JSON.stringify(lines).toLowerCase();
    for (const token of s.tokens) expect(text).not.toContain(token);
    expect(text).not.toContain(s.membershipA);
    expect(
      (
        await rowsOf('SELECT ledger_at FROM lms.account_erasure_requests WHERE id = $1', [
          s.requestId,
        ])
      )[0].ledger_at,
    ).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------ the sweeps
describe('after the account erasure no answer and no table shows the person (sentinel sweep in EACH college, database-wide scan)', () => {
  let s: Seed;
  const ids: Record<'A' | 'B', Record<string, string[]>> = { A: {}, B: {} };

  async function idsFor(tenantId: string, e: Class, pid: string, userId: string) {
    const col = async (sql: string) => (await rowsOf(sql, [tenantId])).map((r) => r.id as string);
    return {
      offeringId: [e.offeringId],
      courseId: [e.courseId],
      moduleId: [e.moduleId],
      participantId: [pid],
      userId: [userId],
      itemId: (
        await rowsOf('SELECT id FROM lms.content_items WHERE offering_id = $1', [e.offeringId])
      ).map((r) => r.id as string),
      scaleId: await col('SELECT id FROM lms.grade_scales WHERE tenant_id = $1'),
      attemptId: await col('SELECT id FROM lms.attempts WHERE tenant_id = $1'),
      questionId: await col('SELECT id FROM lms.questions WHERE tenant_id = $1'),
    };
  }

  beforeAll(async () => {
    s = await seedPerson('Sweep');
    ids.A = await idsFor(A.tenantId, eA, s.participants[0] as string, s.m.userId);
    ids.B = await idsFor(B.tenantId, eB, s.participants[1] as string, s.m.userId);
    expect((await svc().scan()).accountsErased).toBeGreaterThanOrEqual(1);
  }, 360_000);

  const urlsOf = (route: string, map: Record<string, string[]>): string[] => {
    const parts = route.replace(/^\/api/, '').split('/');
    const byParent: Record<string, string> = {
      offerings: 'offeringId',
      courses: 'courseId',
      items: 'itemId',
      members: 'userId',
    };
    let combos: string[][] = [[]];
    for (const [i, seg] of parts.entries()) {
      if (!seg.startsWith(':')) {
        combos = combos.map((c) => [...c, seg]);
        continue;
      }
      const name = seg.slice(1);
      const key = name === 'id' ? byParent[parts[i - 1] ?? ''] : name;
      const vals = (key ? map[key] : undefined) ?? [];
      if (vals.length === 0) return [];
      combos = vals.flatMap((v) => combos.map((c) => [...c, v]));
    }
    return combos.map((c) => c.join('/'));
  };

  for (const [label, e, admin, key] of [
    ['college A', () => eA, () => adminA, 'A'],
    ['college B', () => eB, () => adminB, 'B'],
  ] as const) {
    it(`${label}: every GET route as administrator, instructor and learner shows none of the person's tokens (the frozen gradebook exports are the listed exception)`, async () => {
      const cls = e();
      const callers: [string, TestClient][] = [
        ['admin', admin()],
        ['instructor', cls.instructor.client],
        ['learner', cls.learners[0]?.client as TestClient],
      ];
      const hits = (body: string) => s.tokens.some((tk) => body.toLowerCase().includes(tk));
      let answers = 0;
      const found: { caller: string; url: string }[] = [];
      for (const r of routes) {
        if (
          /storage|\/play\/|\/docs|metrics|download|\.zip|health|unsubscribe|platform/.test(r.url)
        )
          continue;
        for (const url of urlsOf(r.url, ids[key])) {
          for (const [caller, c] of callers) {
            const res = await c.get(url);
            answers++;
            if (hits(res.body)) found.push({ caller, url });
          }
        }
      }
      expect(answers).toBeGreaterThan(100);
      // THE ALLOWED HITS: the frozen gradebook keeps the name and register number it recorded (counsel decides; docs/data-retention.md)
      const allowed = (url: string) => /\/gradebook\/(export\.(csv|xlsx)|snapshots?\b)/.test(url);
      expect(found.filter((f) => !allowed(f.url)).map((f) => `${f.caller} ${f.url}`)).toEqual([]);
    }, 300_000);
  }

  it('the platform administrators see the pseudonym and no address (the list of requests, the audit log)', async () => {
    const list = ok(await p2.get('/platform/account-erasures')).items as Record<string, unknown>[];
    const mine = list.find((x) => x.id === s.requestId);
    expect(mine).toMatchObject({ status: 'done', erased: true, personEmail: null });
    const text = JSON.stringify(ok(await p2.get('/platform/audit?limit=100'))).toLowerCase();
    for (const token of s.tokens) expect(text).not.toContain(token);
    expect(JSON.stringify(list).toLowerCase()).not.toContain(s.tokens[0]);
  });

  it('every text / jsonb / inet column of the database: only the listed places still hold the person', async () => {
    const stored = await whereStored(owner, s.tokens);
    const allowed = [
      'gradebook_snapshot_rows.display_name', // the frozen academic record of college A (counsel decides)
      'gradebook_snapshot_rows.email',
      'gradebook_snapshot_rows.register_number',
    ];
    expect(Object.keys(stored).filter((k) => !allowed.includes(k))).toEqual([]);
    // not empty because of a typo: the global row now holds the pseudonym
    expect(
      (await rowsOf('SELECT display_name FROM lms.users WHERE id = $1', [s.m.userId]))[0]
        .display_name,
    ).toMatch(/^Former user /);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the ledger and a restore
describe('a restore of an OLDER backup does not bring the account back: the ledger erases it again', () => {
  const TABLES: { table: string; where: string; key: string[] }[] = [
    { table: 'users', where: 'id = $1', key: ['id'] },
    { table: 'user_credentials', where: 'user_id = $1', key: ['user_id'] },
    { table: 'sessions', where: 'user_id = $1', key: ['id'] },
    { table: 'auth_tokens', where: 'user_id = $1', key: ['id'] },
    { table: 'tenant_memberships', where: 'user_id = $1', key: ['id'] },
    {
      table: 'member_profiles',
      where: 'membership_id IN (SELECT id FROM lms.tenant_memberships WHERE user_id = $1)',
      key: ['membership_id'],
    },
    { table: 'email_outbox', where: 'user_id = $1', key: ['id'] },
    {
      table: 'email_events',
      where: 'outbox_id IN (SELECT id FROM lms.email_outbox WHERE user_id = $1)',
      key: ['provider', 'event_id'],
    },
    {
      table: 'import_rows',
      where: 'lower(email) IN (SELECT lower(email) FROM lms.users WHERE id = $1)',
      key: ['import_id', 'row_number'],
    },
    { table: 'notifications', where: 'user_id = $1', key: ['id'] },
    {
      table: 'notification_preferences',
      where: 'user_id = $1',
      key: ['tenant_id', 'user_id', 'category', 'channel'],
    },
    { table: 'member_activity_days', where: 'user_id = $1', key: ['tenant_id', 'user_id', 'day'] },
    { table: 'account_erasure_requests', where: 'user_id = $1', key: ['id'] },
  ];
  type Snap = Record<string, Json[]> & {
    suppression: Json[];
    audit: Json[];
    platformAudit: Json[];
  };

  async function snapshot(s: Seed): Promise<Snap> {
    const snap: Record<string, Json[]> = {};
    for (const { table, where } of TABLES)
      snap[table] = (
        await rowsOf(`SELECT row_to_json(x) AS j FROM lms.${table} x WHERE ${where}`, [s.m.userId])
      ).map((r) => r.j);
    snap.suppression = (
      await rowsOf('SELECT row_to_json(x) AS j FROM lms.email_suppressions x WHERE email = $1', [
        s.m.email,
      ])
    ).map((r) => r.j);
    snap.audit = (
      await rowsOf(
        "SELECT row_to_json(x) AS j FROM lms.audit_log x WHERE actor_user_id = $1 OR id = ANY ($2) OR target_id = $1::text OR metadata ->> 'userId' = $1::text OR lower(metadata ->> 'email') = lower($3)",
        [s.m.userId, s.auditIds, s.m.email],
      )
    ).map((r) => r.j);
    snap.platformAudit = (
      await rowsOf('SELECT row_to_json(x) AS j FROM lms.platform_audit_log x WHERE id = ANY ($1)', [
        s.platformAuditIds,
      ])
    ).map((r) => r.j);
    return snap as Snap;
  }

  /** what restoring the rows of an older backup does to the person (the ledger is NOT part of the backup) */
  async function restore(s: Seed, snap: Snap) {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE lms.audit_log DISABLE TRIGGER audit_log_append_only');
      await c.query('DELETE FROM lms.membership_display_overrides WHERE membership_id = ANY ($1)', [
        [s.membershipA, s.membershipB],
      ]);
      await c.query('DELETE FROM lms.erasure_requests WHERE user_id = $1 AND source = $2', [
        s.m.userId,
        'account',
      ]);
      // the account row first (the guard of the other tables looks at erased_at), then the rest
      for (const { table, key } of TABLES) {
        for (const j of snap[table] ?? []) {
          const cols = Object.keys(j as object);
          const assigns = cols
            .filter((k) => !key.includes(k))
            .map((k) => `"${k}" = r."${k}"`)
            .join(', ');
          const keyCond = key.map((k) => `x."${k}" = r."${k}"`).join(' AND ');
          const json = JSON.stringify(j);
          const upd = await c.query(
            `UPDATE lms.${table} x SET ${assigns} FROM json_populate_record(null::lms.${table}, $1::json) r WHERE ${keyCond}`,
            [json],
          );
          if (upd.rowCount === 0)
            await c.query(
              `INSERT INTO lms.${table} SELECT * FROM json_populate_record(null::lms.${table}, $1::json)`,
              [json],
            );
        }
      }
      for (const j of snap.suppression)
        await c.query(
          'UPDATE lms.email_suppressions x SET email = r.email, email_hash = r.email_hash, email_hash_kid = r.email_hash_kid FROM json_populate_record(null::lms.email_suppressions, $1::json) r WHERE x.id = r.id',
          [JSON.stringify(j)],
        );
      for (const j of snap.audit)
        await c.query(
          'UPDATE lms.audit_log x SET metadata = r.metadata FROM json_populate_record(null::lms.audit_log, $1::json) r WHERE x.id = r.id',
          [JSON.stringify(j)],
        );
      for (const j of snap.platformAudit)
        await c.query(
          'UPDATE lms.platform_audit_log x SET metadata = r.metadata, ip = r.ip FROM json_populate_record(null::lms.platform_audit_log, $1::json) r WHERE x.id = r.id',
          [JSON.stringify(j)],
        );
      await c.query('ALTER TABLE lms.audit_log ENABLE TRIGGER audit_log_append_only');
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  it('restore the state from BEFORE the erasure, run pnpm privacy:reapply-erasures: erased again; running it twice changes nothing more', async () => {
    const s = await seedPerson('Ledger');
    const snap = await snapshot(s);
    expect((await svc().scan()).accountsErased).toBe(1);
    await expectAccountErased(s);

    await restore(s, snap);
    // restored: the account is back (address, credentials, no pseudonym), the person's data too
    const u = (
      await rowsOf('SELECT email, erased_at, display_name FROM lms.users WHERE id = $1', [
        s.m.userId,
      ])
    )[0];
    expect(u.erased_at).toBeNull();
    expect(u.email).toBe(s.m.email);
    expect(
      await n1('SELECT count(*)::int AS n FROM lms.user_credentials WHERE user_id = $1', [
        s.m.userId,
      ]),
    ).toBe(1);
    expect(
      await n1(
        'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = ANY ($1)',
        [[s.membershipA, s.membershipB]],
      ),
    ).toBe(0);
    const stored = await whereStored(owner, [
      s.m.email.toLowerCase(),
      s.registerNumber.toLowerCase(),
    ]);
    expect(stored['email_outbox.to_email']).toBeGreaterThan(0);
    expect(stored['email_suppressions.email']).toBeGreaterThan(0);

    // the application's own tool, with the environment of the application
    const env = testEnv(envOverrides());
    const first = await reapplyErasures(env);
    expect(first.reapplied).toBeGreaterThanOrEqual(1);
    expect(first.blocked).toBe(0);
    await expectAccountErased(s);
    const second = await reapplyErasures(env);
    expect(second.reapplied).toBe(0);
    expect(second.already).toBeGreaterThanOrEqual(1);
    // the ledger holds the entry ONCE however many times it is applied
    const lines = (await readFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.requestId === s.requestId)).toHaveLength(1);
  }, 360_000);

  it('a person with a live membership is NOT erased by the ledger (blocked, the command says so, a second run after the college entries finds it done)', async () => {
    const s = await seedPerson('Blocked');
    const snap = await snapshot(s);
    expect((await svc().scan()).accountsErased).toBe(1);
    await restore(s, snap);
    // the restored state has the person ACTIVE in a college whose erasure the ledger does not know (e.g. re-invited before the backup)
    await owner.query("UPDATE lms.tenant_memberships SET status = 'active' WHERE id = $1", [
      s.membershipB,
    ]);
    const env = testEnv(envOverrides());
    const out = await reapplyErasures(env);
    expect(out.blocked).toBeGreaterThanOrEqual(1);
    expect(
      (await rowsOf('SELECT erased_at FROM lms.users WHERE id = $1', [s.m.userId]))[0].erased_at,
    ).toBeNull();
    // the membership is removed (the college's own decision), the next run erases the account
    await owner.query("UPDATE lms.tenant_memberships SET status = 'removed' WHERE id = $1", [
      s.membershipB,
    ]);
    const again = await reapplyErasures(env);
    expect(again.reapplied).toBeGreaterThanOrEqual(1);
    expect(
      (await rowsOf('SELECT erased_at FROM lms.users WHERE id = $1', [s.m.userId]))[0].erased_at,
    ).not.toBeNull();
  }, 360_000);
});
