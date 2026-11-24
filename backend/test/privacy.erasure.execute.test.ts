import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reapplyErasures } from '../src/cli/privacy-reapply-erasures';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp, testEnv } from './app';
import { deliverEmails, TestClient } from './client';
import { type Json, loginAs, ok, type Person, person, structure } from './courses-helpers';
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
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// DATA PROTECTION, step 14b-1 part 3: THE EXECUTION OF AN ERASURE INSIDE A COLLEGE.
// The nine items of the erasure checklist in CLAUDE.md, one test each, on a member who has a little of everything: two sessions, queued
// and sent mail, a provider event, a suppressed address, staged import rows, audit rows with addresses, a profile, a bell, preferences,
// activity and a ready data export. Then the sentinel sweep over every GET route (admin, instructor, learner), the database-wide scan
// with the allowed hits listed, the cross-college check (the same person in another college is byte-identical), and the erasure LEDGER:
// restore an older state, re-apply the ledger, the person is erased again.

const KEYS = `k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`;
const DAY = 86_400_000;

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let st: Awaited<ReturnType<typeof structure>>;
let e: Class;
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
  ledgerDir = await mkdtemp(join(tmpdir(), 'lms-ledger-x-'));
  t = makeApp({ env: envOverrides() });
  t.app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/docs') || route.schema?.hide === true) return;
    if (!route.url.startsWith('/api/')) return;
    for (const m of Array.isArray(route.method) ? route.method : [route.method])
      if (m === 'GET') routes.push({ method: m, url: route.url });
  });
  A = await createAuthFixture(owner, 'erx-a');
  B = await createAuthFixture(owner, 'erx-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Plain Pat', 'Plain Quin']);
}, 180_000);

afterAll(async () => {
  await t.close();
  await owner.end();
  await rm(ledgerDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------------------------ a member with a little of everything
interface Seed {
  m: Person;
  second: TestClient;
  registerNumber: string;
  phone: string;
  tokens: string[];
  outboxQueued: string;
  outboxSent: string;
  eventId: string;
  importId: string;
  auditIds: string[];
  otherAuditId: string;
  exportId: string;
  exportKey: string;
  requestId: string;
}

let counter = 0;
async function seedMember(label: string): Promise<Seed> {
  const n = ++counter;
  const name = `ZQ${label}${n} Vale`;
  const m = await person(owner, t, A, name);
  // a student profile: register number + a phone number
  const pids0 = await owner.query('SELECT id FROM lms.tenant_memberships WHERE id = $1', [
    m.membershipId,
  ]);
  expect(pids0.rowCount).toBe(1);
  const phone = `+91 98765 4${String(n).padStart(4, '0')}`;
  ok(
    await admin.patch(`/members/${m.userId}/profile`, {
      profileType: 'student',
      registerNumber: `ZQREG${n}X`,
      batchId: st.batchId,
      sectionId: st.sectionA,
      phone,
    }),
  );
  const registerNumber = `ZQREG${n}X`;
  // enrolled in the class, one quiz and one assignment with released results (bell + mail), a second session
  ok(
    await admin.post(`/offerings/${e.offeringId}/participants`, {
      userId: m.userId,
      participation: 'learner',
    }),
  );
  const second = new TestClient(t, A.host);
  expect((await second.login(m.email, TEST_PASSWORD)).statusCode).toBe(200);
  ok(
    await m.client.put('/me/notification-preferences', {
      category: 'learning_content',
      email: false,
      inApp: true,
    }),
  );
  await m.client.get('/auth/me');
  // mail: one queued, one sent (+ a provider event on it), and a suppressed address
  const outboxQueued = newId();
  const outboxSent = newId();
  for (const [id, status] of [
    [outboxQueued, 'queued'],
    [outboxSent, 'sent'],
  ] as const)
    await owner.query(
      `INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params, status)
       VALUES ($1, $2, $3, $4, $5, 'learning_content', 'content_digest', '{"course":"C","count":1,"titles":["x"],"link":"/offerings/o"}', $6)`,
      [id, A.tenantId, `seed:${id}`, m.userId, m.email, status],
    );
  const eventId = `evt-${newId()}`;
  await owner.query(
    "INSERT INTO lms.email_events (provider, event_id, kind, email, outbox_id, received_at) VALUES ('test', $1, 'delivered', $2, $3, now())",
    [eventId, m.email, outboxSent],
  );
  await owner.query(
    "INSERT INTO lms.email_suppressions (id, email, reason) VALUES ($1, $2, 'bounce')",
    [newId(), m.email],
  );
  // staged import rows that carry the address
  const imp = await upload(
    admin,
    'faculty',
    csv(FACULTY_HEADER, [[m.email, name, `EMP-ZQ${n}`, 'NOPE']]),
  );
  const importId = ok(imp).id as string;
  // audit rows: the sign-ins above wrote ones with the address of the client; an invite-like row names the address; one is unrelated
  const auditIds = [newId(), newId()];
  await owner.query(
    `INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES
       ($1, $3, $4, 'test.invite', 'membership', $5, jsonb_build_object('email', $6::text, 'ip', '10.9.9.9', 'keep', 'yes')),
       ($2, $3, $7, 'test.about_member', 'user', $8, jsonb_build_object('ip', '10.8.8.8', 'keep', 'yes'))`,
    [
      auditIds[0],
      auditIds[1],
      A.tenantId,
      A.adminUserId,
      m.membershipId,
      m.email,
      A.adminUserId,
      m.userId,
    ],
  );
  const otherAuditId = newId();
  await owner.query(
    "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, 'test.unrelated', 'x', 'y', '{\"ip\":\"10.7.7.7\"}')",
    [otherAuditId, A.tenantId, A.adminUserId],
  );
  // a ready data export
  const req = ok(await m.client.post('/me/data-exports', { password: TEST_PASSWORD }));
  const exportId = req.export.id as string;
  await t.app.modules.handlers['privacy.export']?.run(
    { exportId },
    {
      jobId: newId(),
      queue: 'privacy.export',
      tenantId: A.tenantId,
      attempt: 1,
      maxAttempts: 3,
      signal: new AbortController().signal,
    },
  );
  const exportKey = (
    await owner.query('SELECT storage_key FROM lms.data_exports WHERE id = $1', [exportId])
  ).rows[0].storage_key as string;
  expect(exportKey).toBeTruthy();
  // the request, approved and due
  const requestId = ok(await m.client.post('/me/erasure', { password: TEST_PASSWORD })).request
    .id as string;
  ok(await admin.post(`/privacy/erasure-requests/${requestId}/approve`, {}));
  await owner.query(
    "UPDATE lms.erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
    [requestId],
  );
  return {
    m,
    second,
    registerNumber,
    phone,
    tokens: [
      `zq${label.toLowerCase()}${n}`,
      m.email.toLowerCase(),
      registerNumber.toLowerCase(),
      phone.slice(4),
    ],
    outboxQueued,
    outboxSent,
    eventId,
    importId,
    auditIds,
    otherAuditId,
    exportId,
    exportKey,
    requestId,
  };
}

const hashOf = (address: string, secret: string) =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', secret, '', 'lms.suppression-hash', 32)))
    .update(address.trim().toLowerCase())
    .digest('hex');

async function auditCount(): Promise<number> {
  return Number((await owner.query('SELECT count(*)::int AS n FROM lms.audit_log')).rows[0].n);
}

/** everything the checklist promises, for one erased member (also asserted again after a ledger re-application) */
async function expectErased(s: Seed, opts: { audit: { before: number } }) {
  const { m } = s;
  // 1: sessions of the member in this college: ALL revoked, their address and agent wiped; the old cookies are dead
  const sessions = (
    await owner.query(
      'SELECT revoked_at, ip, user_agent FROM lms.sessions WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, m.userId],
    )
  ).rows;
  expect(sessions.length).toBeGreaterThanOrEqual(2);
  for (const r of sessions) expect(r).toMatchObject({ ip: null, user_agent: null });
  expect(sessions.every((r) => r.revoked_at !== null)).toBe(true);
  expect((await m.client.get('/auth/me')).statusCode).toBe(401);
  expect((await s.second.get('/auth/me')).statusCode).toBe(401);
  // 2: the membership is removed, the override is there; nothing can be sent to them any more
  expect(
    (await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [m.membershipId]))
      .rows[0].status,
  ).toBe('removed');
  expect(
    Number(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
          [m.membershipId],
        )
      ).rows[0].n,
    ),
  ).toBe(1);
  // 3: every outbox row of theirs is blanked, what was queued is skipped, and the sender sends nothing to them
  const outbox = (
    await owner.query(
      'SELECT id, status, to_email, params, skip_reason FROM lms.email_outbox WHERE user_id = $1 AND tenant_id = $2',
      [m.userId, A.tenantId],
    )
  ).rows;
  expect(outbox.length).toBeGreaterThanOrEqual(2);
  for (const r of outbox) expect(r).toMatchObject({ to_email: 'erased.invalid', params: {} });
  expect(outbox.find((r) => r.id === s.outboxQueued)).toMatchObject({
    status: 'skipped',
    skip_reason: 'member_erased',
  });
  expect(outbox.find((r) => r.id === s.outboxSent)?.status).toBe('sent');
  t.mailer.sent.length = 0;
  await deliverEmails(t);
  expect(t.mailer.sent.filter((x) => x.to === m.email)).toEqual([]);
  // 4: the provider events of those rows lost the address
  expect(
    (await owner.query('SELECT email FROM lms.email_events WHERE event_id = $1', [s.eventId]))
      .rows[0].email,
  ).toBeNull();
  // 5: the suppression of the address carries the KEYED hash (the current key, its id recorded); the plain address stays while the account lives
  const sup = (
    await owner.query(
      "SELECT email, encode(email_hash, 'hex') AS h, email_hash_kid FROM lms.email_suppressions WHERE email = $1",
      [m.email],
    )
  ).rows[0];
  expect(sup).toBeDefined();
  expect(sup.email_hash_kid).toBe('k2');
  expect(sup.h).toBe(hashOf(m.email, 'b'.repeat(40)));
  expect(sup.h).not.toBe(createHash('sha256').update(m.email).digest('hex')); // not a plain hash
  // 6: staged import rows scrubbed; audit rows keep their ids and their other keys, lose ip / email / address keys; nothing deleted
  const imp = (
    await owner.query(
      'SELECT email, full_name, register_number, employee_id, phone, raw FROM lms.import_rows WHERE import_id = $1',
      [s.importId],
    )
  ).rows;
  expect(imp.length).toBeGreaterThan(0);
  for (const r of imp)
    expect(r).toMatchObject({
      email: null,
      full_name: null,
      register_number: null,
      employee_id: null,
      phone: null,
      raw: {},
    });
  const a1 = (
    await owner.query('SELECT metadata FROM lms.audit_log WHERE id = $1', [s.auditIds[0]])
  ).rows[0];
  const a2 = (
    await owner.query('SELECT metadata FROM lms.audit_log WHERE id = $1', [s.auditIds[1]])
  ).rows[0];
  expect(a1.metadata).toEqual({ keep: 'yes' });
  // the profile audit rows keep their ids and their other fields, and lose the phone, register number and the like inside before / after
  const profAudit = (
    await owner.query(
      "SELECT metadata FROM lms.audit_log WHERE tenant_id = $1 AND action LIKE 'profile.%' AND metadata ->> 'userId' = $2",
      [A.tenantId, m.userId],
    )
  ).rows;
  expect(profAudit.length).toBeGreaterThan(0);
  for (const r of profAudit)
    for (const side of ['before', 'after'])
      if (r.metadata[side]) {
        for (const k of ['phone', 'designation', 'register_number', 'employee_id'])
          expect(Object.keys(r.metadata[side])).not.toContain(k);
        expect(Object.keys(r.metadata[side])).toContain('membership_id');
      }
  expect(a2.metadata).toEqual({ keep: 'yes' });
  expect(
    (await owner.query('SELECT metadata FROM lms.audit_log WHERE id = $1', [s.otherAuditId]))
      .rows[0].metadata,
  ).toEqual({ ip: '10.7.7.7' });
  const loginRows = (
    await owner.query(
      "SELECT metadata FROM lms.audit_log WHERE tenant_id = $1 AND actor_user_id = $2 AND action LIKE 'auth.%'",
      [A.tenantId, m.userId],
    )
  ).rows;
  for (const r of loginRows) expect(Object.keys(r.metadata)).not.toContain('ip');
  expect(await auditCount()).toBeGreaterThanOrEqual(opts.audit.before); // never deleted
  // 7: the profile's personal fields are gone; the bell, preferences and activity are deleted; the search keys follow the pseudonym
  const prof = (
    await owner.query(
      'SELECT phone, designation, register_number, employee_id FROM lms.member_profiles WHERE membership_id = $1',
      [m.membershipId],
    )
  ).rows[0];
  expect(prof).toEqual({
    phone: null,
    designation: null,
    register_number: null,
    employee_id: null,
  });
  for (const table of ['notifications', 'notification_preferences', 'member_activity_days'])
    expect(
      Number(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM lms.${table} WHERE tenant_id = $1 AND user_id = $2`,
            [A.tenantId, m.userId],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  const keys = (
    await owner.query(
      'SELECT search_name, search_email FROM lms.tenant_memberships WHERE id = $1',
      [m.membershipId],
    )
  ).rows[0];
  expect(keys.search_name).toMatch(/^former member [0-9a-f]{8}$/);
  expect(keys.search_email).toBeNull();
  // the archive of their data: expired, and its object is deleted by the purge job
  expect(
    (await owner.query('SELECT status FROM lms.data_exports WHERE id = $1', [s.exportId])).rows[0]
      .status,
  ).toBe('expired');
}

// ------------------------------------------------------------------------------------------------------------------ the nine items
describe('the execution satisfies the erasure checklist', () => {
  let s: Seed;
  let auditBefore = 0;
  let snapshotBefore: Json;

  beforeAll(async () => {
    s = await seedMember('Mona');
    // the gradebook that froze her name and register number BEFORE the erasure: the academic record, kept
    const pids = await participantIds(owner, e.offeringId, [s.m]);
    const q1 = await quiz(e, 'Quiz One', [true, false]);
    await releaseQuiz(e, q1.id);
    await assignment(owner, e, 'Essay', [80, 65], { release: true, dueInPast: true });
    await approveGradebook(e, admin, pids[0]);
    snapshotBefore = (
      await owner.query(
        'SELECT display_name, email, register_number FROM lms.gradebook_snapshot_rows WHERE participant_id = $1',
        [pids[0]],
      )
    ).rows[0];
    expect(snapshotBefore.display_name).toContain('ZQMona');
    auditBefore = await auditCount();
    // things that exist BEFORE: the sentinels are in the places the inventory lists (the scan has teeth)
    const stored = await whereStored(owner, s.tokens);
    for (const place of [
      'users.display_name',
      'users.email',
      'email_outbox.to_email',
      'import_rows.email',
      'member_profiles.register_number',
      'member_profiles.phone',
      'audit_log.metadata',
      'email_suppressions.email',
      'gradebook_snapshot_rows.display_name',
    ])
      expect(Object.keys(stored), place).toContain(place);
    // execute: through the worker's scan (one transaction per request)
    const out = await svc().scan();
    expect(out.erased).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('1-7: sessions, membership, outbox, events, suppression hash, imports and audit keys, profile, bell: all in place', async () => {
    await expectErased(s, { audit: { before: auditBefore } });
    expect(await deliverEmails(t)).toBeGreaterThanOrEqual(0);
  });

  it('the request is done, audited, with counts and no value; the purge job deletes the archive object', async () => {
    const r = (
      await owner.query(
        'SELECT status, executed_at, ledger_at FROM lms.erasure_requests WHERE id = $1',
        [s.requestId],
      )
    ).rows[0];
    expect(r.status).toBe('done');
    expect(r.executed_at).not.toBeNull();
    const a = (
      await owner.query(
        "SELECT metadata FROM lms.audit_log WHERE action = 'privacy.erasure_executed' AND target_id = $1",
        [s.requestId],
      )
    ).rows[0];
    expect(a.metadata).toMatchObject({
      sessionsRevoked: expect.any(Number),
      emailsBlanked: expect.any(Number),
      suppressionsSealed: 1,
    });
    expect(JSON.stringify(a.metadata)).not.toMatch(/zq/i);
    const purge = t.app.modules.handlers['privacy.purge_exports'];
    await purge?.run(
      {},
      {
        jobId: newId(),
        queue: 'privacy.purge_exports',
        tenantId: null,
        attempt: 1,
        maxAttempts: 3,
        signal: new AbortController().signal,
      },
    );
    expect(
      (await owner.query('SELECT storage_key FROM lms.data_exports WHERE id = $1', [s.exportId]))
        .rows[0].storage_key,
    ).toBeNull();
  });

  it('8: every kind of notice to the erased member produces nothing: no bell row, no outbox row, no address stored (the fan-out refuses a removed member)', async () => {
    const before = Number(
      (
        await owner.query('SELECT count(*)::int AS n FROM lms.email_outbox WHERE user_id = $1', [
          s.m.userId,
        ])
      ).rows[0].n,
    );
    const note = Number(
      (
        await owner.query('SELECT count(*)::int AS n FROM lms.notifications WHERE user_id = $1', [
          s.m.userId,
        ])
      ).rows[0].n,
    );
    for (const category of [
      'security',
      'learning_grades',
      'learning_deadlines',
      'learning_content',
      'admin',
    ]) {
      await owner.query(
        `SELECT lms.notify_fanout(ARRAY[ROW($1, $2, $3, 'extension_granted', '{"course":"C","item":"I"}'::jsonb, '/offerings/o', $4, 'extension_granted', NULL::timestamptz, true)::lms.notify_item])`,
        [A.tenantId, s.m.userId, category, `after:${category}:${newId()}`],
      );
    }
    for (const template of ['password_changed', 'password_reset', 'invite', 'admin_promoted']) {
      const r = await owner.query(
        'SELECT lms.email_enqueue_security($1, $2, $3, $4::jsonb, $5) AS ok',
        [A.tenantId, s.m.userId, template, '{}', `sec:${template}:${newId()}`],
      );
      expect(r.rows[0].ok, template).toBe(false);
    }
    expect(
      Number(
        (
          await owner.query('SELECT count(*)::int AS n FROM lms.email_outbox WHERE user_id = $1', [
            s.m.userId,
          ])
        ).rows[0].n,
      ),
    ).toBe(before);
    expect(
      Number(
        (
          await owner.query('SELECT count(*)::int AS n FROM lms.notifications WHERE user_id = $1', [
            s.m.userId,
          ])
        ).rows[0].n,
      ),
    ).toBe(note);
    // the college's own functions refuse them too: no suppression clearing, no unsubscribe page, no list entry
    const info = await owner.query(
      "SELECT * FROM lms.notify_unsubscribe_info($1, $2, 'learning_content')",
      [A.tenantId, s.m.userId],
    );
    expect(info.rowCount).toBe(0);
    const list = await owner.query(
      'SELECT * FROM lms.email_suppressions_for_tenant($1, NULL, 100)',
      [A.tenantId],
    );
    expect(JSON.stringify(list.rows)).not.toContain(s.m.email);
    // a released grade after the erasure reaches nobody of theirs either
    await owner.query('UPDATE lms.assignment_grades SET released_at = now() WHERE tenant_id = $1', [
      A.tenantId,
    ]);
    expect(
      Number(
        (
          await owner.query('SELECT count(*)::int AS n FROM lms.email_outbox WHERE user_id = $1', [
            s.m.userId,
          ])
        ).rows[0].n,
      ),
    ).toBe(before);
  });

  it('9: kept, as said: submissions, attempts, progress and the frozen gradebook (name and register number as the academic record); shown under the pseudonym everywhere else', async () => {
    const snap = (
      await owner.query(
        'SELECT display_name, email, register_number FROM lms.gradebook_snapshot_rows WHERE display_name = $1',
        [snapshotBefore.display_name],
      )
    ).rows;
    expect(snap).toHaveLength(1);
    expect(snap[0]).toEqual(snapshotBefore);
    const kept = (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.course_participants WHERE membership_id = $1',
        [s.m.membershipId],
      )
    ).rows[0].n;
    expect(Number(kept)).toBeGreaterThanOrEqual(1);
    const members = ok(await admin.get('/members?status=removed&limit=100')).items as Json[];
    const mine = members.find((x) => x.userId === s.m.userId);
    expect(mine).toMatchObject({ status: 'removed', email: '' });
    expect(mine?.displayName).toMatch(/^Former member [0-9A-F]{8}$/);
  });

  it('the erasure ledger holds the request, membership, user, college, level and time: ids only, outside the database; the database knows it is written', async () => {
    const text = await readFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'utf8');
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const mine = lines.find((l) => l.requestId === s.requestId);
    expect(mine).toEqual({
      v: 1,
      requestId: s.requestId,
      tenantId: A.tenantId,
      membershipId: s.m.membershipId,
      userId: s.m.userId,
      level: 'college',
      at: expect.any(String),
    });
    for (const token of s.tokens) expect(text.toLowerCase()).not.toContain(token);
    expect(text.toLowerCase()).not.toMatch(/@|zq/);
    expect(
      (await owner.query('SELECT ledger_at FROM lms.erasure_requests WHERE id = $1', [s.requestId]))
        .rows[0].ledger_at,
    ).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------ the sweeps
describe('after the erasure no answer and no table shows the person (sentinel sweep, database-wide scan)', () => {
  let s: Seed;
  let instructor: Class['instructor'];
  const ids: Record<string, string[]> = {};

  beforeAll(async () => {
    instructor = e.instructor;
    s = await seedMember('Sweep');
    const lena = s.m;
    // she did things the instructor and admin see: a quiz attempt, a hand-in, a grade
    const pid = (await participantIds(owner, e.offeringId, [lena]))[0] as string;
    ids.offeringId = [e.offeringId];
    ids.courseId = [e.courseId];
    ids.moduleId = [e.moduleId];
    ids.participantId = [pid];
    ids.userId = [lena.userId];
    ids.itemId = (
      await owner.query('SELECT id FROM lms.content_items WHERE offering_id = $1', [e.offeringId])
    ).rows.map((r) => r.id as string);
    ids.scaleId = (
      await owner.query('SELECT id FROM lms.grade_scales WHERE tenant_id = $1', [A.tenantId])
    ).rows.map((r) => r.id as string);
    ids.attemptId = (
      await owner.query('SELECT id FROM lms.attempts WHERE tenant_id = $1', [A.tenantId])
    ).rows.map((r) => r.id as string);
    ids.questionId = (
      await owner.query('SELECT id FROM lms.questions WHERE tenant_id = $1', [A.tenantId])
    ).rows.map((r) => r.id as string);
    expect((await svc().scan()).erased).toBeGreaterThanOrEqual(1);
  }, 240_000);

  const valuesFor = (name: string, before: string): string[] => {
    const byParent: Record<string, string> = {
      offerings: 'offeringId',
      courses: 'courseId',
      items: 'itemId',
      members: 'userId',
    };
    const key = name === 'id' ? byParent[before] : name;
    return (key ? ids[key] : undefined) ?? [];
  };
  const urlsOf = (route: string): string[] => {
    const parts = route.replace(/^\/api/, '').split('/');
    let combos: string[][] = [[]];
    for (const [i, seg] of parts.entries()) {
      if (!seg.startsWith(':')) {
        combos = combos.map((c) => [...c, seg]);
        continue;
      }
      const vals = valuesFor(seg.slice(1), parts[i - 1] ?? '');
      if (vals.length === 0) return [];
      combos = vals.flatMap((v) => combos.map((c) => [...c, v]));
    }
    return combos.map((c) => c.join('/'));
  };

  it('every GET route as administrator, instructor and learner: not a token of the erased member (the frozen gradebook exports are the listed exception)', async () => {
    const callers: [string, TestClient][] = [
      ['admin', admin],
      ['instructor', instructor.client],
      ['learner', e.learners[0]?.client as TestClient],
    ];
    const hits = (body: string) => s.tokens.some((tk) => body.toLowerCase().includes(tk));
    let answers = 0;
    const found: { caller: string; url: string }[] = [];
    for (const r of routes) {
      if (/storage|\/play\/|\/docs|metrics|download|\.zip|health|unsubscribe/.test(r.url)) continue;
      for (const url of urlsOf(r.url)) {
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

  it('every text / jsonb / inet column of the database: only the listed places still hold the person', async () => {
    const stored = await whereStored(owner, s.tokens);
    const allowed = [
      'email_suppressions.email', // the address that bounced: it stays plain while the account lives; its keyed hash is stored beside it
      'gradebook_snapshot_rows.display_name', // the frozen academic record (counsel decides)
      'gradebook_snapshot_rows.email',
      'gradebook_snapshot_rows.register_number',
      'users.display_name', // the GLOBAL account: erased only at account level (next part)
      'users.email',
    ];
    expect(Object.keys(stored).filter((k) => !allowed.includes(k))).toEqual([]);
    // the lists are not empty because of a typo: the global account is really there
    expect(stored['users.email']).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------ another college
describe('erasing in college A leaves the same person in college B byte for byte as they were', () => {
  it("B's tables, the global account row, B's member list and B's session are unchanged", async () => {
    const s = await seedMember('Both');
    const m = s.m;
    // the same person is a member of B, with a session, mail, an audit row, a profile
    const bMembership = newId();
    await owner.query(
      "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')",
      [bMembership, B.tenantId, m.userId],
    );
    await owner.query(
      "INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params, status) VALUES ($1, $2, $3, $4, $5, 'learning_content', 'content_digest', '{\"a\":1}', 'queued')",
      [newId(), B.tenantId, `b:${newId()}`, m.userId, m.email],
    );
    await owner.query(
      "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, 'test.b', 'user', $4, jsonb_build_object('ip', '10.2.2.2', 'email', $5::text))",
      [newId(), B.tenantId, m.userId, m.userId, m.email],
    );
    await owner.query(
      "INSERT INTO lms.notifications (id, tenant_id, user_id, category, type, params, dedupe_key) VALUES ($1, $2, $3, 'learning_content', 'content_digest', '{}', $4)",
      [newId(), B.tenantId, m.userId, `b:${newId()}`],
    );
    const onB = new TestClient(t, B.host);
    expect((await onB.login(m.email, TEST_PASSWORD)).statusCode).toBe(200);
    const adminB = await loginAs(t, B.host, B.adminEmail);

    const fingerprint = async () => {
      const tabs = (
        await owner.query(
          "SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'lms' AND column_name = 'tenant_id' ORDER BY 1",
        )
      ).rows as { t: string }[];
      const out: Record<string, string> = {};
      for (const { t: table } of tabs) {
        const r = await owner.query(
          `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM lms."${table}" x WHERE tenant_id = $1`,
          [B.tenantId],
        );
        out[table] = r.rows[0].h;
      }
      out.users = (
        await owner.query('SELECT md5(x::text) AS h FROM lms.users x WHERE id = $1', [m.userId])
      ).rows[0].h;
      out.credentials = (
        await owner.query(
          'SELECT md5(password_hash) AS h FROM lms.user_credentials WHERE user_id = $1',
          [m.userId],
        )
      ).rows[0].h;
      return out;
    };
    const membersB = async () =>
      JSON.stringify(
        (ok(await adminB.get('/members?limit=100')).items as Json[]).find(
          (x) => x.userId === m.userId,
        ),
      );
    const listBefore = await membersB();
    await t.app.modules.background.drain(); // the activity rows of the sign-ins and the list are written in the background
    const before = await fingerprint();
    expect(listBefore).toContain(m.email);

    expect((await svc().scan()).erased).toBeGreaterThanOrEqual(1);
    expect(
      Number(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
            [m.membershipId],
          )
        ).rows[0].n,
      ),
    ).toBe(1);

    await t.app.modules.background.drain();
    const after = await fingerprint();
    // B's own tables: the only thing that may differ is B's rows of the shared rollups / sessions' last_seen (none are touched by an erasure)
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([]);
    expect(after).toEqual(before);
    expect(await membersB()).toBe(listBefore);
    expect((await onB.get('/auth/me')).statusCode).toBe(200); // B's session lives on
    expect((await m.client.get('/auth/me')).statusCode).toBe(401); // A's is gone
    expect(
      (await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [bMembership]))
        .rows[0].status,
    ).toBe('active');
  }, 240_000);
});

// ------------------------------------------------------------------------------------------------------------------ the ledger and a restore
describe('a restore of an OLDER backup does not bring the person back: the ledger erases them again', () => {
  /** the rows an erasure changes, as JSON, for the restore emulation */
  async function snapshot(s: Seed) {
    const q = async (sql: string, p: unknown[]) => (await owner.query(sql, p)).rows;
    return {
      membership: (
        await q(
          'SELECT status, search_name, search_email FROM lms.tenant_memberships WHERE id = $1',
          [s.m.membershipId],
        )
      )[0],
      profile: (
        await q(
          'SELECT phone, designation, register_number, employee_id FROM lms.member_profiles WHERE membership_id = $1',
          [s.m.membershipId],
        )
      )[0],
      sessions: await q(
        'SELECT id, revoked_at, ip, user_agent FROM lms.sessions WHERE tenant_id = $1 AND user_id = $2',
        [A.tenantId, s.m.userId],
      ),
      outbox: await q(
        'SELECT id, status, skip_reason, to_email, params FROM lms.email_outbox WHERE tenant_id = $1 AND user_id = $2',
        [A.tenantId, s.m.userId],
      ),
      events: await q(
        'SELECT provider, event_id, email FROM lms.email_events WHERE outbox_id = ANY ($1)',
        [[s.outboxQueued, s.outboxSent]],
      ),
      imports: await q('SELECT row_to_json(r) AS j FROM lms.import_rows r WHERE import_id = $1', [
        s.importId,
      ]),
      audit: await q('SELECT id, metadata FROM lms.audit_log WHERE id = ANY ($1)', [
        [...s.auditIds],
      ]),
      loginAudit: await q(
        "SELECT id, metadata FROM lms.audit_log WHERE tenant_id = $1 AND actor_user_id = $2 AND action LIKE 'auth.%'",
        [A.tenantId, s.m.userId],
      ),
      notifications: await q(
        'SELECT row_to_json(n) AS j FROM lms.notifications n WHERE tenant_id = $1 AND user_id = $2',
        [A.tenantId, s.m.userId],
      ),
      prefs: await q(
        'SELECT row_to_json(n) AS j FROM lms.notification_preferences n WHERE tenant_id = $1 AND user_id = $2',
        [A.tenantId, s.m.userId],
      ),
      activity: await q(
        'SELECT row_to_json(n) AS j FROM lms.member_activity_days n WHERE tenant_id = $1 AND user_id = $2',
        [A.tenantId, s.m.userId],
      ),
      exportRow: (
        await q('SELECT status, storage_key FROM lms.data_exports WHERE id = $1', [s.exportId])
      )[0],
    };
  }
  type Snap = Awaited<ReturnType<typeof snapshot>>;

  /** what restoring the rows of an older backup does to the person's data (the ledger is NOT part of the backup) */
  async function restore(s: Seed, snap: Snap) {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE lms.audit_log DISABLE TRIGGER audit_log_append_only');
      await c.query('DELETE FROM lms.membership_display_overrides WHERE membership_id = $1', [
        s.m.membershipId,
      ]);
      await c.query('DELETE FROM lms.erasure_requests WHERE membership_id = $1', [
        s.m.membershipId,
      ]);
      await c.query(
        'UPDATE lms.tenant_memberships SET status = $2, search_name = $3, search_email = $4 WHERE id = $1',
        [
          s.m.membershipId,
          snap.membership.status,
          snap.membership.search_name,
          snap.membership.search_email,
        ],
      );
      await c.query(
        'UPDATE lms.member_profiles SET phone = $2, designation = $3, register_number = $4, employee_id = $5 WHERE membership_id = $1',
        [
          s.m.membershipId,
          snap.profile.phone,
          snap.profile.designation,
          snap.profile.register_number,
          snap.profile.employee_id,
        ],
      );
      for (const r of snap.sessions)
        await c.query(
          'UPDATE lms.sessions SET revoked_at = $2, ip = $3, user_agent = $4 WHERE id = $1',
          [r.id, r.revoked_at, r.ip, r.user_agent],
        );
      for (const r of snap.outbox)
        await c.query(
          'UPDATE lms.email_outbox SET status = $2, skip_reason = $3, to_email = $4, params = $5 WHERE id = $1',
          [r.id, r.status, r.skip_reason, r.to_email, r.params],
        );
      for (const r of snap.events)
        await c.query(
          'UPDATE lms.email_events SET email = $3 WHERE provider = $1 AND event_id = $2',
          [r.provider, r.event_id, r.email],
        );
      for (const r of snap.imports)
        await c.query(
          'UPDATE lms.import_rows x SET email = r.email, full_name = r.full_name, register_number = r.register_number, employee_id = r.employee_id, phone = r.phone, raw = r.raw FROM json_populate_record(null::lms.import_rows, $1::json) r WHERE x.import_id = r.import_id AND x.row_number = r.row_number',
          [JSON.stringify(r.j)],
        );
      for (const r of [...snap.audit, ...snap.loginAudit])
        await c.query('UPDATE lms.audit_log SET metadata = $2 WHERE id = $1', [r.id, r.metadata]);
      for (const [table, list] of [
        ['notifications', snap.notifications],
        ['notification_preferences', snap.prefs],
        ['member_activity_days', snap.activity],
      ] as const)
        for (const r of list)
          await c.query(
            `INSERT INTO lms.${table} SELECT * FROM json_populate_record(null::lms.${table}, $1::json) ON CONFLICT DO NOTHING`,
            [JSON.stringify(r.j)],
          );
      await c.query('UPDATE lms.data_exports SET status = $2, storage_key = $3 WHERE id = $1', [
        s.exportId,
        snap.exportRow.status,
        snap.exportRow.storage_key,
      ]);
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
    const s = await seedMember('Ledger');
    const snap = await snapshot(s);
    const auditBefore = await auditCount();
    expect((await svc().scan()).erased).toBeGreaterThanOrEqual(1);
    await expectErased(s, { audit: { before: auditBefore } });

    await restore(s, snap);
    // restored: the person is back (active, the profile, the address in the outbox and in the audit rows)
    expect(
      (
        await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [
          s.m.membershipId,
        ])
      ).rows[0].status,
    ).toBe('active');
    expect(
      (
        await owner.query('SELECT phone FROM lms.member_profiles WHERE membership_id = $1', [
          s.m.membershipId,
        ])
      ).rows[0].phone,
    ).toBe(s.phone);
    expect(
      Number(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
            [s.m.membershipId],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    const stored = await whereStored(owner, [
      s.m.email.toLowerCase(),
      s.registerNumber.toLowerCase(),
    ]);
    expect(stored['email_outbox.to_email']).toBeGreaterThan(0);

    // the application's own tool, with the environment of the application
    const env = testEnv(envOverrides());
    const first = await reapplyErasures(env);
    expect(first.reapplied).toBeGreaterThanOrEqual(1);
    await expectErased({ ...s, m: s.m }, { audit: { before: auditBefore } });
    const second = await reapplyErasures(env);
    expect(second.reapplied).toBe(0);
    expect(second.already).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('a ledger entry for a person this database does not know is "nothing to do", and a damaged ledger is refused, not guessed', async () => {
    await appendFile(
      join(ledgerDir, 'erasure-ledger.jsonl'),
      `${JSON.stringify({ v: 1, requestId: newId(), tenantId: A.tenantId, membershipId: newId(), userId: newId(), level: 'college', at: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const r = await svc().reapplyFromLedger();
    expect(r.nothing).toBeGreaterThanOrEqual(1);
    await appendFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'this is not json\n');
    await expect(svc().reapplyFromLedger()).rejects.toThrow(/refusing to guess/);
    // restore the file for the tests after this one
    const text = await readFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'utf8');
    await rm(join(ledgerDir, 'erasure-ledger.jsonl'));
    await appendFile(
      join(ledgerDir, 'erasure-ledger.jsonl'),
      text.replace('this is not json\n', ''),
    );
  });

  it('a person who is erased, then asks nothing more: the ledger entry is written only after the commit (never for a request that was blocked)', async () => {
    const lines = (await readFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const blocked = (
      await owner.query(
        "SELECT id FROM lms.erasure_requests WHERE status IN ('rejected', 'cancelled', 'expired', 'approved', 'pending_approval')",
      )
    ).rows.map((r) => r.id as string);
    for (const l of lines) expect(blocked).not.toContain(l.requestId);
    const done = (
      await owner.query(
        "SELECT id FROM lms.erasure_requests WHERE status = 'done' AND source = 'member'",
      )
    ).rows.map((r) => r.id as string);
    for (const id of done) expect(lines.map((l) => l.requestId)).toContain(id);
  });
});

void DAY;
void newId;
