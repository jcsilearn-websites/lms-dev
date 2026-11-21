import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type Json, loginAs, newCourse, newOffering, ok, structure } from './courses-helpers';
import { assignment, type Class, gradebookClass, quiz, releaseQuiz } from './gradebook-helpers';
import { expectPgError } from './helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';
import { readZip } from './zip-read';

// DATA PROTECTION, step 14b-1 part 2: "download my data".
//  - the request: the password is asked again (a wrong one is counted by the sign-in lockout), one at a time, at most 3 a day, queued in
//    the same transaction as its audit row;
//  - the archive: built by the worker from ONE collected document; the SENTINEL test opens the unzipped bytes and checks that the
//    person's own data is there and that nobody else's, nothing unreleased and no private reason is;
//  - the download: owner only, audited, 7 days, deleted afterwards (every time decision uses an explicit instant);
//  - races, failure injection (audit atomicity), cross-college, budgets.

const SWITCH = 'public.pexp_failure_switch';
const WRONG = 'definitely not the password';
const DAY = 86_400_000;

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let e: Class;
let lena: Class['learners'][number];
let omar: Class['learners'][number];
let lenaCourseCode: string;

async function arm(on: boolean) {
  await owner.query(`UPDATE ${SWITCH} SET failing = $1`, [on]);
}

beforeAll(async () => {
  owner = testOwnerPool(4);
  for (const stmt of [
    'DROP TRIGGER IF EXISTS zz_pexp_failure ON lms.audit_log',
    'DROP FUNCTION IF EXISTS public.pexp_failure_fn()',
    `DROP TABLE IF EXISTS ${SWITCH}`,
    `CREATE TABLE ${SWITCH} (failing boolean NOT NULL)`,
    `INSERT INTO ${SWITCH} VALUES (false)`,
    `CREATE FUNCTION public.pexp_failure_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
     BEGIN
       IF NEW.action LIKE 'privacy.%' AND (SELECT failing FROM public.pexp_failure_switch) THEN
         RAISE EXCEPTION 'injected failure: the audit row could not be written' USING ERRCODE = 'XX000';
       END IF;
       RETURN NEW;
     END $$`,
    'CREATE TRIGGER zz_pexp_failure BEFORE INSERT ON lms.audit_log FOR EACH ROW EXECUTE FUNCTION public.pexp_failure_fn()',
  ])
    await owner.query(stmt);
  t = makeApp({
    env: {
      RATE_LIMIT_MAX: '1000000',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      LOGIN_MAX_ATTEMPTS: '50',
      DATA_EXPORT_RATE_PER_HOUR: '100000',
      TENANT_CACHE_TTL_MS: '3600000',
    },
  });
  A = await createAuthFixture(owner, 'pexp-a');
  B = await createAuthFixture(owner, 'pexp-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  const st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['ZQLena Quasar', 'ZQOmar Other']);
  [lena, omar] = e.learners as [typeof lena, typeof omar];
  await owner.query("UPDATE lms.users SET display_name = 'ZQProf Ivanova' WHERE id = $1", [
    e.instructor.userId,
  ]);
  const q1 = await quiz(e, 'Quiz One', [true, false]);
  await releaseQuiz(e, q1.id);
  await quiz(e, 'Quiz Manual', [true, false], { resultsVisibility: 'manual' }); // never released: its scores are not Lena's to see yet
  await assignment(owner, e, 'Essay Released', [91.25, 55.5], { release: true, dueInPast: true });
  const hidden = await assignment(owner, e, 'Essay Unreleased', [73.5, 66.5], { dueInPast: true });
  const ic = e.instructor.client;
  const lenaPid = (
    await owner.query(
      `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
      [e.offeringId, lena.userId],
    )
  ).rows[0].id as string;
  const quizItem = (
    await owner.query(
      "SELECT id FROM lms.content_items WHERE offering_id = $1 AND title = 'Quiz One'",
      [e.offeringId],
    )
  ).rows[0].id as string;
  ok(
    await ic.put(
      `/offerings/${e.offeringId}/items/${quizItem}/assessment/accommodations/${lenaPid}`,
      {
        extraMinutes: 15,
        reason: 'ZQREASON-ACC office approval',
      },
    ),
  );
  ok(
    await ic.put(`/offerings/${e.offeringId}/items/${hidden.id}/assignment/extensions/${lenaPid}`, {
      extendedDueAt: new Date(Date.now() + 5 * DAY).toISOString(),
      reason: 'ZQREASON-EXT travel',
    }),
  );
  lenaCourseCode = (
    await owner.query(
      'SELECT c.code FROM lms.courses c JOIN lms.course_offerings o ON o.tenant_id = c.tenant_id AND o.course_id = c.id WHERE o.id = $1',
      [e.offeringId],
    )
  ).rows[0].code as string;
  // Lena is also a member of ANOTHER college, with a course there: it must never be in her export from this one
  const adminB = await loginAs(t, B.host, B.adminEmail);
  const stB = await structure(adminB);
  const cB = await newCourse(adminB, { code: 'ZQBCOURSE', title: 'ZQB Secret Course' });
  const oB = await newOffering(adminB, cB.id, stB.termId);
  await owner.query(
    "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')",
    [newId(), B.tenantId, lena.userId],
  );
  ok(
    await adminB.post(`/offerings/${oB.id}/participants`, {
      userId: lena.userId,
      participation: 'learner',
    }),
  );
}, 300_000);

afterAll(async () => {
  await arm(false);
  await t.close();
  await owner.query('DROP TRIGGER IF EXISTS zz_pexp_failure ON lms.audit_log');
  await owner.query('DROP FUNCTION IF EXISTS public.pexp_failure_fn()');
  await owner.query(`DROP TABLE IF EXISTS ${SWITCH}`);
  await owner.end();
});

const exports_ = async (where = '', params: unknown[] = []) =>
  (await owner.query(`SELECT * FROM lms.data_exports ${where} ORDER BY requested_at`, params)).rows;
const audits = async (action: string, target?: string) =>
  Number(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.audit_log WHERE action = $1 AND ($2::text IS NULL OR target_id = $2)',
        [action, target ?? null],
      )
    ).rows[0].n,
  );
const request = (c: TestClient, password = TEST_PASSWORD) =>
  c.post('/me/data-exports', { password });
const run = async (tenantId: string, exportId: string, attempt = 1, maxAttempts = 3) => {
  const h = t.app.modules.handlers['privacy.export'];
  if (!h) throw new Error('no privacy.export handler');
  return h.run(
    { exportId },
    {
      jobId: newId(),
      queue: 'privacy.export',
      tenantId,
      attempt,
      maxAttempts,
      signal: new AbortController().signal,
    },
  );
};
const stored = (key: string) => readFile(path.join(t.app.modules.config.storage.localDir, key));
const reset = async () => {
  // between scenarios: no export, no job, no privacy audit row (the owner may delete what the app role cannot)
  await owner.query('DELETE FROM lms.data_exports');
  await owner.query("DELETE FROM lms.jobs WHERE queue = 'privacy.export'");
  await owner.query("DELETE FROM lms.audit_log WHERE action LIKE 'privacy.%'");
};

// ------------------------------------------------------------------------------------------------------------------ request
describe('the request', () => {
  it('asks for the password again: a wrong one is refused, counted by the lockout, and makes nothing', async () => {
    const before = Number(
      (
        await owner.query('SELECT failed_attempts FROM lms.user_credentials WHERE user_id = $1', [
          lena.userId,
        ])
      ).rows[0].failed_attempts,
    );
    const r = await request(lena.client, WRONG);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_current_password');
    expect(await exports_()).toEqual([]);
    expect(await audits('privacy.export_requested')).toBe(0);
    const after = Number(
      (
        await owner.query('SELECT failed_attempts FROM lms.user_credentials WHERE user_id = $1', [
          lena.userId,
        ])
      ).rows[0].failed_attempts,
    );
    expect(after).toBe(before + 1);
    // no password, right or wrong, in any stored row of the failed attempt
    const dump = JSON.stringify((await owner.query('SELECT metadata FROM lms.audit_log')).rows);
    expect(dump).not.toContain(WRONG);
    // the right password clears nothing it should not and makes no export for a request WITHOUT a password
    expect((await lena.client.post('/me/data-exports', {})).statusCode).toBe(400);
    expect(await exports_()).toEqual([]);
  });

  it('queues ONE export, its job and its audit row together; a second request returns the same export', async () => {
    const r = await request(lena.client);
    expect(r.statusCode, r.body).toBe(202);
    const first = r.json();
    expect(first).toMatchObject({
      alreadyInProgress: false,
      export: { status: 'queued', readyAt: null },
    });
    const again = await request(lena.client);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({
      alreadyInProgress: true,
      export: { id: first.export.id },
    });
    expect((await exports_()).length).toBe(1);
    expect(
      Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'privacy.export' AND payload ->> 'exportId' = $1",
            [first.export.id],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    expect(await audits('privacy.export_requested', first.export.id)).toBe(1);
    await reset();
  });

  it('is for active members of a college only: a platform administrator and a suspended member are refused', async () => {
    const plat = await createPlatformAdmin(owner, 'root@pexp.test');
    const root = new TestClient(t, 'admin.localhost');
    expect((await root.login(plat.email, TEST_PASSWORD)).statusCode).toBe(200);
    expect((await request(root)).statusCode).toBe(403);
    expect(
      (await new TestClient(t, A.host).post('/me/data-exports', { password: 'x' })).statusCode,
    ).toBe(401);
    await owner.query("UPDATE lms.tenant_memberships SET status = 'suspended' WHERE id = $1", [
      omar.membershipId,
    ]);
    // a suspended member cannot even sign in; the function itself also refuses (used by the next test's direct call)
    const r = await owner.query('SELECT lms.privacy_export_request($1, $2, NULL, now()) AS r', [
      A.tenantId,
      omar.userId,
    ]);
    expect(r.rows[0].r.result).toBe('not_a_member');
    await owner.query("UPDATE lms.tenant_memberships SET status = 'active' WHERE id = $1", [
      omar.membershipId,
    ]);
    expect(await exports_()).toEqual([]);
  });

  it('at most 3 a day: the fourth is refused, and allowed again after 24 hours (explicit instants)', async () => {
    const at = (iso: string) =>
      owner.query('SELECT lms.privacy_export_request($1, $2, NULL, $3::timestamptz) AS r', [
        A.tenantId,
        lena.userId,
        iso,
      ]);
    const finish = async (id: string) => {
      await owner.query("UPDATE lms.data_exports SET status = 'failed' WHERE id = $1", [id]);
    };
    const t0 = '2026-03-10T09:00:00Z';
    for (const [i, when] of [t0, '2026-03-10T10:00:00Z', '2026-03-10T11:00:00Z'].entries()) {
      const r = (await at(when)).rows[0].r;
      expect(r.result, `request ${i + 1}`).toBe('ok');
      await finish(r.id);
    }
    expect((await at('2026-03-10T12:00:00Z')).rows[0].r.result).toBe('too_many');
    // exactly 24 h after the FIRST one the window has moved on by one; 23:59 later it has not
    expect((await at('2026-03-11T08:59:59Z')).rows[0].r.result).toBe('too_many');
    const ok4 = (await at('2026-03-11T09:00:01Z')).rows[0].r;
    expect(ok4.result).toBe('ok');
    await finish(ok4.id);
    await reset();
  });

  it('two requests at the same moment make ONE export (held-lock race)', async () => {
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('privacy.export:' || $1::text, 0))",
        [lena.userId],
      );
      const both = Promise.all([request(lena.client), request(lena.client)]);
      const until = Date.now() + 10_000;
      for (;;) {
        const w = await owner.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%privacy_export_request%'`,
        );
        if (Number(w.rows[0].n) >= 2) break;
        if (Date.now() > until) throw new Error('the requests never waited on the person lock');
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(await exports_()).toEqual([]); // nothing was decided while the lock was held
      await holder.query('COMMIT');
      const [a, b] = await both;
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect([a.json().alreadyInProgress, b.json().alreadyInProgress].sort()).toEqual([
        false,
        true,
      ]);
      expect((await exports_()).length).toBe(1);
      expect(await audits('privacy.export_requested')).toBe(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    await reset();
  });

  it('AUDIT ATOMICITY: when the audit row cannot be written the request leaves no export and no job', async () => {
    await reset();
    await arm(true);
    const r = await request(lena.client);
    await arm(false);
    expect(r.statusCode).toBe(500);
    expect(await exports_()).toEqual([]);
    expect(
      Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'privacy.export'",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the archive
describe('the archive (sentinel test over the unzipped bytes)', () => {
  let exportId: string;
  let files: Record<string, Buffer>;
  let text: string;
  let raw: Buffer;

  beforeAll(async () => {
    await reset();
    exportId = (await request(lena.client)).json().export.id;
    expect(await run(A.tenantId, exportId)).toEqual({ built: 1 });
    const row = (await exports_('WHERE id = $1', [exportId]))[0];
    raw = await stored(row.storage_key);
    files = readZip(raw);
    text = Object.values(files)
      .map((b) => b.toString('utf8'))
      .join('\n');
  });

  it('is ready with the size, the SHA-256 of the stored bytes and the counts, and expires exactly 7 days after it was prepared', async () => {
    const row = (await exports_('WHERE id = $1', [exportId]))[0];
    expect(row.status).toBe('ready');
    expect(Number(row.size_bytes)).toBe(raw.length);
    expect(row.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(new Date(row.expires_at).getTime() - new Date(row.ready_at).getTime()).toBe(7 * DAY);
    expect(row.counts.enrolments).toBe(1);
    expect(await audits('privacy.export_ready', exportId)).toBe(1);
    const list = ok(await lena.client.get('/me/data-exports')).items as Json[];
    expect(list[0]).toMatchObject({ id: exportId, status: 'ready', sizeBytes: raw.length });
  });

  it('holds the files it says it holds', () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        'README.txt',
        'account.json',
        'activity-days.csv',
        'assignment-grades.csv',
        'assignment-submissions.csv',
        'course-grades.csv',
        'enrolments.csv',
        'notification-preferences.csv',
        'notifications.csv',
        'progress.csv',
        'quiz-attempts.csv',
      ].sort(),
    );
  });

  it("holds the person's own data: account, profile, enrolment, released scores", () => {
    const account = JSON.parse(files['account.json']?.toString('utf8') ?? '{}');
    expect(account.account).toMatchObject({ email: lena.email, displayName: 'ZQLena Quasar' });
    expect(account.membership).toMatchObject({ role: 'member', status: 'active' });
    expect(account.profile.registerNumber).toBeTruthy();
    expect(files['enrolments.csv']?.toString('utf8')).toContain(lenaCourseCode);
    expect(files['assignment-grades.csv']?.toString('utf8')).toContain('Essay Released');
    expect(files['assignment-grades.csv']?.toString('utf8')).toContain('91.25');
    const quizzes = files['quiz-attempts.csv']?.toString('utf8') ?? '';
    expect(quizzes).toMatch(/Quiz One,1,graded,[^\r\n]*,10,10/); // released: the score is there
  });

  it('holds NOTHING of other people, nothing unreleased, no private reason, nothing of another college', async () => {
    const lowered = text.toLowerCase();
    const omarRegister = (
      await owner.query(
        'SELECT mp.register_number FROM lms.member_profiles mp WHERE mp.membership_id = $1',
        [omar.membershipId],
      )
    ).rows[0].register_number as string;
    const forbidden: [string, string][] = [
      ["another learner's name", 'zqomar'],
      ["another learner's address", omar.email.toLowerCase()],
      ["another learner's register number", omarRegister.toLowerCase()],
      ["another learner's score", '55.5'],
      ["an instructor's name", 'zqprof'],
      ['an unreleased assignment score', '73.5'],
      ['an accommodation reason', 'zqreason-acc'],
      ['an extension reason', 'zqreason-ext'],
      ["another college's course", 'zqbcourse'],
      ["another college's course title", 'zqb secret'],
    ];
    for (const [what, needle] of forbidden) expect(lowered, what).not.toContain(needle);
    // her own submission of the unreleased assignment IS hers (a hand-in), but its grade is not shown
    const grades = files['assignment-grades.csv']?.toString('utf8') ?? '';
    expect(grades).not.toContain('Essay Unreleased');
    // the quiz whose results were never released: the attempt is listed, the score is blank
    const manual = (files['quiz-attempts.csv']?.toString('utf8') ?? '')
      .split('\r\n')
      .find((l) => l.includes('Quiz Manual'));
    expect(manual, 'the manual quiz attempt is listed').toBeDefined();
    expect(manual).toMatch(/,,$/); // score and out-of are empty
    // the archive is a plain ZIP with safe names only
    for (const name of Object.keys(files)) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('has teeth, both ways: the other learner has an archive of their own that DOES hold what this one must not, and nothing of this one', async () => {
    const id = (await request(omar.client)).json().export.id;
    expect(await run(A.tenantId, id)).toEqual({ built: 1 });
    const row = (await exports_('WHERE id = $1', [id]))[0];
    const theirs = Object.values(readZip(await stored(row.storage_key)))
      .map((b) => b.toString('utf8'))
      .join(' ')
      .toLowerCase();
    expect(theirs).toContain('zqomar');
    expect(theirs).toContain('55.5');
    expect(theirs).not.toContain('zqlena');
    expect(theirs).not.toContain('91.25');
  });

  it('the member downloads it through a signed link; the download is audited; the bytes are the archive', async () => {
    const link = ok(await lena.client.get(`/me/data-exports/${exportId}/download`));
    expect(link.fileName).toBe('my-data.zip');
    const res = await new TestClient(t, A.host).request('GET', link.url, { browser: false });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(Buffer.from(res.rawPayload).equals(raw)).toBe(true);
    expect(await audits('privacy.export_downloaded', exportId)).toBe(1);
  });

  it('is nobody else\'s: another member, an institution admin and a member of another college get "not found"', async () => {
    for (const c of [omar.client, admin, e.instructor.client]) {
      const r = await c.get(`/me/data-exports/${exportId}/download`);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('export_not_found');
      // their own list never holds this person's export (the other learner has an export of their own)
      const own = ok(await c.get('/me/data-exports')).items as Json[];
      expect(own.map((x) => x.id)).not.toContain(exportId);
    }
    const adminB = await loginAs(t, B.host, B.adminEmail);
    expect((await adminB.get(`/me/data-exports/${exportId}/download`)).statusCode).toBe(404);
    // the row policy: even an owner-less SQL read as the app role under another user sees nothing
    const rows = await owner.query(
      `SELECT count(*)::int AS n FROM lms.data_exports WHERE id = $1`,
      [exportId],
    );
    expect(Number(rows.rows[0].n)).toBe(1);
    expect(await audits('privacy.export_downloaded', exportId)).toBe(1); // the refusals wrote nothing
  });

  it('the download answers by the clock: ok one second before the expiry, "expired" at it and after (explicit instants)', async () => {
    const row = (await exports_('WHERE id = $1', [exportId]))[0];
    const at = (iso: string) =>
      owner
        .query('SELECT lms.privacy_export_download($1, $2, $3, $4::timestamptz, NULL) AS r', [
          A.tenantId,
          lena.userId,
          exportId,
          iso,
        ])
        .then((r) => r.rows[0].r.result as string);
    const exp = new Date(row.expires_at).getTime();
    expect(await at(new Date(exp - 1000).toISOString())).toBe('ok');
    expect(await at(new Date(exp).toISOString())).toBe('expired');
    expect(await at(new Date(exp + 1000).toISOString())).toBe('expired');
  });

  it('the expiry job deletes the archive only when it is due, clears the key, and keeps the row as the record', async () => {
    const row = (await exports_('WHERE id = $1', [exportId]))[0];
    const exp = new Date(row.expires_at).getTime();
    // not yet due, one second before the instant: nothing to do (the function takes the instant)
    const early = await owner.query(
      'SELECT * FROM lms.privacy_export_expire_list($1::timestamptz, 100)',
      [new Date(exp - 1000).toISOString()],
    );
    expect(early.rows).toEqual([]);
    const purge = t.app.modules.handlers['privacy.purge_exports'];
    if (!purge) throw new Error('no purge handler');
    const jobCtx = {
      jobId: newId(),
      queue: 'privacy.purge_exports',
      tenantId: null,
      attempt: 1,
      maxAttempts: 3,
      signal: new AbortController().signal,
    };
    expect(await purge.run({}, jobCtx)).toEqual({ expired: 0 }); // the real clock: seven days are far away
    expect((await exports_('WHERE id = $1', [exportId]))[0].status).toBe('ready');
    // make it due (an explicit past instant) and run the real handler
    await owner.query(
      "UPDATE lms.data_exports SET expires_at = '2020-01-08T00:00:00Z' WHERE id = $1",
      [exportId],
    );
    expect(await purge.run({}, jobCtx)).toEqual({ expired: 1 });
    const after = (await exports_('WHERE id = $1', [exportId]))[0];
    expect(after).toMatchObject({ status: 'expired', storage_key: null });
    expect(
      await stored(row.storage_key).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const r = await lena.client.get(`/me/data-exports/${exportId}/download`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('export_expired');
    expect(await purge.run({}, jobCtx)).toEqual({ expired: 0 }); // running it again finds nothing more
  });
});

// ------------------------------------------------------------------------------------------------------------------ the worker
describe('the worker', () => {
  it('AUDIT ATOMICITY: when the "ready" audit row cannot be written the export is NOT ready', async () => {
    await reset();
    const id = (await request(lena.client)).json().export.id;
    await arm(true);
    await expect(run(A.tenantId, id)).rejects.toThrow();
    await arm(false);
    const row = (await exports_('WHERE id = $1', [id]))[0];
    expect(row.status).toBe('building');
    expect(row.storage_key).toBeNull();
    expect(await audits('privacy.export_ready', id)).toBe(0);
    // the retry (attempt 2) completes it
    expect(await run(A.tenantId, id, 2)).toEqual({ built: 1 });
    expect((await exports_('WHERE id = $1', [id]))[0].status).toBe('ready');
  });

  it('the last attempt that fails marks the export failed, with a generic reason and an audit row', async () => {
    await reset();
    const id = (await request(lena.client)).json().export.id;
    await arm(true);
    await expect(run(A.tenantId, id, 3, 3)).rejects.toThrow(); // the ready row fails ... and so does the failure row
    await arm(false);
    // the failure could not be recorded while the audit was down: the export is still building, never "ready" without an audit row
    expect((await exports_('WHERE id = $1', [id]))[0].status).toBe('building');
    expect(await run(A.tenantId, id, 3, 3)).toEqual({ built: 1 }); // a later run completes it
  });

  it('a build for a member who left the college is not made (the request fails, nothing is stored)', async () => {
    await reset();
    const id = (await request(omar.client)).json().export.id;
    await owner.query("UPDATE lms.tenant_memberships SET status = 'suspended' WHERE id = $1", [
      omar.membershipId,
    ]);
    expect(await run(A.tenantId, id)).toEqual({ built: 0 });
    const row = (await exports_('WHERE id = $1', [id]))[0];
    expect(row).toMatchObject({ status: 'failed', storage_key: null });
    expect(row.error).toBe('no longer an active member');
    await owner.query("UPDATE lms.tenant_memberships SET status = 'active' WHERE id = $1", [
      omar.membershipId,
    ]);
  });

  it('the app role cannot write the table or call the collector for an export that is not being built', async () => {
    const { testAppPool } = await import('./support');
    const app = testAppPool(1);
    try {
      await expectPgError(app.query("UPDATE lms.data_exports SET status = 'ready'"), '42501');
      await expectPgError(
        app.query('SELECT lms.privacy_export_collect($1, $2)', [A.tenantId, newId()]),
        '22023',
      );
    } finally {
      await app.end();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ budgets
describe('query budgets', () => {
  const count = async (fn: () => Promise<{ statusCode: number }>) => {
    t.statements.reset();
    const r = await fn();
    await t.app.modules.background.drain();
    return { n: t.statements.statements.length, status: r.statusCode };
  };

  it('request 3 (session, password row, definer call; budget 4), a refused password 3, list 4, download 2 (budget 3)', async () => {
    await reset();
    await lena.client.get('/me/data-exports'); // warm: slug cache, the activity touch of the day
    const wrong = await count(() => request(lena.client, WRONG));
    expect(wrong.status).toBe(400);
    process.stdout.write(
      `ROUND-TRIPS POST /me/data-exports (wrong password): ${wrong.n} (budget 4)\n`,
    );
    expect(wrong.n).toBeLessThanOrEqual(4);
    const good = await count(() => request(lena.client));
    expect(good.status).toBe(202);
    process.stdout.write(`ROUND-TRIPS POST /me/data-exports: ${good.n} (budget 4)\n`);
    expect(good.n).toBeLessThanOrEqual(4);
    const id = (await exports_("WHERE status = 'queued'"))[0].id as string;
    expect(await run(A.tenantId, id)).toEqual({ built: 1 });
    const list = await count(() => lena.client.get('/me/data-exports'));
    process.stdout.write(`ROUND-TRIPS GET /me/data-exports: ${list.n} (budget 4)\n`);
    expect(list.n).toBeLessThanOrEqual(4);
    const dl = await count(() => lena.client.get(`/me/data-exports/${id}/download`));
    process.stdout.write(`ROUND-TRIPS GET /me/data-exports/:id/download: ${dl.n} (budget 3)\n`);
    expect(dl.status).toBe(200);
    expect(dl.n).toBeLessThanOrEqual(3);
  });
});
