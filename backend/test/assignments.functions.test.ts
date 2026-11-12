// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { addAssignment, base, classOf, handIn, me, queue } from './assignments-helpers';
import type { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// Step 10: the hardening of the definer functions (grants, search_path, columns), what lms_app may and may not write,
// history (nothing cascades into submissions and grades, nothing is deleted or updated), isolation between colleges.

let owner: pg.Pool;
let app: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'asf-a');
  B = await createAuthFixture(owner, 'asf-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
  await app.end();
});

const LEARNER_FUNCTIONS = [
  'assignment_upload_begin',
  'assignment_submit',
  'assignment_me',
  'assignment_file_access',
  'assignment_upload_check',
];
const HELPERS = [
  'assignment_penalty_percent',
  'assignment_timing',
  'assignment_final_points',
  'assignment_default_row',
  'assignment_final_scores',
  'anon_code',
  'effective_arrival',
];

describe('the definer functions of step 10', () => {
  it('are SECURITY DEFINER, pinned to search_path = lms, pg_temp, owned by the migration role, EXECUTE for lms_app only', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.proname = ANY($1)`,
      [LEARNER_FUNCTIONS],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...LEARNER_FUNCTIONS].sort());
    const migrationOwner = (await owner.query('SELECT current_user AS u')).rows[0].u;
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe(migrationOwner);
      expect(r.proconfig, r.proname).toContain('search_path=lms, pg_temp');
      expect(r.app, r.proname).toBe(true);
      expect(r.anon, r.proname).toBe(false);
      expect(r.authed, r.proname).toBe(false);
      expect(r.pub, r.proname).toBe(false);
    }
  });

  it('every helper is pinned too, and the trigger function is out of reach', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.proconfig, has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.proname = ANY($1)`,
      [HELPERS],
    );
    expect(rows).toHaveLength(HELPERS.length);
    for (const r of rows) {
      expect(r.pub, r.proname).toBe(false);
      expect(r.proconfig, r.proname).toContain('search_path=lms, pg_temp');
    }
    expect(rows.find((r) => r.proname === 'assignment_default_row').app).toBe(false);
  });

  it('a hijacked search_path cannot redirect a function: a rogue table in public is never read', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Hijack']);
    const item = await addAssignment(e);
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TEMP TABLE assignments (tenant_id uuid, item_id uuid)`);
      await c.query(`SET LOCAL search_path = pg_temp, public`);
      const r = (
        await c.query(`SELECT lms.assignment_me($1, $2, $3, $4, 600) AS r`, [
          A.tenantId,
          e.learners[0]!.userId,
          e.offeringId,
          item.id,
        ])
      ).rows[0].r;
      // the real function ran with the real tables: the learner of this offering gets their page
      expect(r.result).toBe('ok');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('lms_app can read submissions but neither update nor delete them; grades are updated only in their columns', async () => {
    const priv = async (table: string, column: string, kind: 'UPDATE' | 'INSERT') =>
      (
        await owner.query(`SELECT has_column_privilege('lms_app', $1, $2, $3) AS p`, [
          `lms.${table}`,
          column,
          kind,
        ])
      ).rows[0].p as boolean;
    const tbl = async (name: string, kind: string) =>
      (
        await owner.query(`SELECT has_table_privilege('lms_app', $1, $2) AS p`, [
          `lms.${name}`,
          kind,
        ])
      ).rows[0].p as boolean;
    for (const name of ['submissions', 'submission_files', 'assignment_uploads']) {
      expect(await tbl(name, 'INSERT'), `${name} insert`).toBe(false);
      expect(await tbl(name, 'DELETE'), `${name} delete`).toBe(false);
      expect(await tbl(name, 'SELECT'), `${name} select`).toBe(true);
    }
    for (const col of [
      'text_body',
      'link_url',
      'submitted_at',
      'late_seconds',
      'version_no',
      'participant_id',
    ])
      expect(await priv('submissions', col, 'UPDATE'), `submissions.${col}`).toBe(false);
    for (const name of [
      'assignment_grades',
      'rubrics',
      'rubric_versions',
      'assignment_learners',
      'assignments',
    ])
      expect(await tbl(name, 'DELETE'), `${name} delete`).toBe(false);
    // the identity of a grade cannot be changed
    for (const col of ['tenant_id', 'assignment_item_id', 'participant_id'])
      expect(await priv('assignment_grades', col, 'UPDATE'), `assignment_grades.${col}`).toBe(
        false,
      );
    // rubric versions are immutable
    for (const col of ['criteria', 'max_points', 'version_no'])
      expect(await priv('rubric_versions', col, 'UPDATE'), `rubric_versions.${col}`).toBe(false);
    // the random key and the code of a learner are never changed
    for (const col of ['learner_key', 'anon_code'])
      expect(await priv('assignment_learners', col, 'UPDATE'), `assignment_learners.${col}`).toBe(
        false,
      );
  });

  it('HISTORY: submissions and grades are not deleted with their participant, item or file (ON DELETE RESTRICT)', async () => {
    const e = await classOf(owner, t, A, admin, st, ['History']);
    const item = await addAssignment(e);
    ok(await handIn(e, e.learners[0]!, item.id));
    await queue(e, e.instructor, item.id);
    const fk = (
      await owner.query(
        `SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref, confdeltype
           FROM pg_constraint
          WHERE contype = 'f' AND conrelid::regclass::text IN
            ('lms.submissions', 'lms.submission_files', 'lms.assignment_grades')`,
      )
    ).rows;
    expect(fk.length).toBeGreaterThan(6);
    // 'r' = RESTRICT, 'a' = NO ACTION (the deferred cycle of rubrics only); never 'c' (cascade) or 'n' (set null)
    for (const r of fk) expect(['r', 'a'], `${r.tbl} -> ${r.ref}`).toContain(r.confdeltype);
    const { rows } = await owner.query(
      `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
      [e.offeringId, e.learners[0]!.userId],
    );
    await expect(
      owner.query('DELETE FROM lms.course_participants WHERE id = $1', [rows[0].id]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      owner.query('DELETE FROM lms.assignments WHERE item_id = $1', [item.id]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      owner.query('DELETE FROM lms.files WHERE id IN (SELECT file_id FROM lms.submission_files)'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a file used by a submission, an attachment or a feedback file is never purged; an abandoned draft is', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Purge']);
    const item = await addAssignment(e);
    const l = e.learners[0]!;
    ok(await handIn(e, l, item.id));
    // an abandoned draft: uploaded, never handed in
    const req = ok(
      await l.client.post(`${base(e, item.id)}/files`, { name: 'draft.pdf', size: 40 }),
    );
    const used = (
      await owner.query(
        `SELECT f.id FROM lms.submission_files sf JOIN lms.files f ON f.id = sf.file_id JOIN lms.submissions s ON s.id = sf.submission_id WHERE s.assignment_item_id = $1`,
        [item.id],
      )
    ).rows[0].id;
    await owner.query(
      `UPDATE lms.files SET created_at = now() - interval '3 days' WHERE id = ANY($1)`,
      [[used, req.fileId]],
    );
    await owner.query(
      `UPDATE lms.files SET confirmed_at = now() - interval '3 days' WHERE id = $1`,
      [used],
    );
    const purged = (await owner.query(`SELECT * FROM lms.files_purge(interval '24 hours', 100)`))
      .rows;
    const keys = purged.map((r) => r.storage_key as string);
    const draftKey = (
      await owner.query('SELECT storage_key FROM lms.files WHERE id = $1', [req.fileId])
    ).rowCount;
    expect(draftKey).toBe(0);
    const usedKey = (await owner.query('SELECT storage_key FROM lms.files WHERE id = $1', [used]))
      .rows[0]?.storage_key;
    expect(usedKey).toBeTruthy();
    expect(keys).not.toContain(usedKey);
    // the draft entry went with its file (ephemeral rows may cascade)
    const d = (
      await owner.query('SELECT 1 FROM lms.assignment_uploads WHERE file_id = $1', [req.fileId])
    ).rowCount;
    expect(d).toBe(0);
  });

  it('do not accept another college: the same user id with the other tenant finds nothing and writes nothing', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Iso']);
    const item = await addAssignment(e);
    const uid = e.learners[0]!.userId;
    const call = async (sqlText: string, params: unknown[]) =>
      (await app.query(sqlText, params)).rows[0].r;
    expect(
      (
        await call(`SELECT lms.assignment_me($1, $2, $3, $4, 600) AS r`, [
          B.tenantId,
          uid,
          e.offeringId,
          item.id,
        ])
      ).result,
    ).not.toBe('ok');
    expect(
      (
        await call(
          `SELECT lms.assignment_submit($1, $2, $3, $4, $5, 'x', NULL, '{}', false, 600) AS r`,
          [B.tenantId, uid, e.offeringId, item.id, randomUUID()],
        )
      ).result,
    ).not.toBe('ok');
    expect(
      (
        await call(
          `SELECT lms.assignment_upload_begin($1, $2, $3, $4, $5, 'k', 'a.pdf', 'application/pdf', 10, 600) AS r`,
          [B.tenantId, uid, e.offeringId, item.id, randomUUID()],
        )
      ).result,
    ).not.toBe('ok');
    expect(
      (await owner.query('SELECT 1 FROM lms.submissions WHERE assignment_item_id = $1', [item.id]))
        .rowCount,
    ).toBe(0);
    // and a user of the right college who is not in the offering is refused too
    const other = await classOf(owner, t, A, admin, st, ['Other']);
    expect(
      (
        await call(`SELECT lms.assignment_me($1, $2, $3, $4, 600) AS r`, [
          A.tenantId,
          other.learners[0]!.userId,
          e.offeringId,
          item.id,
        ])
      ).result,
    ).toBe('no_offering');
  });

  it("another college's staff cannot reach an assignment, a rubric or a key", async () => {
    const e = await classOf(owner, t, A, admin, st, ['Cross']);
    const item = await addAssignment(e);
    ok(await handIn(e, e.learners[0]!, item.id));
    await queue(e, e.instructor, item.id);
    const bAdmin = await loginAs(t, B.host, B.adminEmail);
    expect((await bAdmin.get(`${base(e, item.id)}`)).statusCode).toBe(404);
    expect((await bAdmin.get(`${base(e, item.id)}/grading/queue`)).statusCode).toBe(404);
    expect((await bAdmin.get(`/courses/${e.courseId}/rubrics`)).statusCode).toBe(404);
    // the raw tables are empty for the other college's application connection
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [B.tenantId]);
      for (const name of [
        'assignments',
        'submissions',
        'submission_files',
        'assignment_grades',
        'assignment_learners',
        'assignment_uploads',
        'assignment_extensions',
        'assignment_attachments',
        'assignment_feedback_files',
        'rubrics',
        'rubric_versions',
      ])
        expect((await c.query(`SELECT 1 FROM lms.${name}`)).rowCount, name).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('a learner key and an anonymous code are random: not the participant id, not derived from it', async () => {
    const e = await classOf(owner, t, A, admin, st, ['K1', 'K2', 'K3', 'K4']);
    const item = await addAssignment(e);
    await queue(e, e.instructor, item.id);
    const { rows } = await owner.query(
      'SELECT learner_key, anon_code, participant_id FROM lms.assignment_learners WHERE assignment_item_id = $1',
      [item.id],
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.learner_key).not.toBe(r.participant_id);
      expect(String(r.anon_code)).toMatch(/^[A-Z2-9]{6}$/);
      // not time-ordered like the ids the application makes (UUIDv7 has version nibble 7; a random key is version 4)
      expect(String(r.learner_key)[14]).toBe('4');
    }
    expect(new Set(rows.map((r) => r.anon_code)).size).toBe(4);
  });

  it('the page of a learner never carries the code or the key of anybody', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Page1', 'Page2']);
    const item = await addAssignment(e);
    ok(await handIn(e, e.learners[0]!, item.id));
    await queue(e, e.instructor, item.id);
    const { rows } = await owner.query(
      'SELECT learner_key, anon_code FROM lms.assignment_learners WHERE assignment_item_id = $1',
      [item.id],
    );
    const page = JSON.stringify(await me(e, e.learners[0]!, item.id));
    for (const r of rows) {
      expect(page).not.toContain(r.learner_key);
      expect(page).not.toContain(r.anon_code);
    }
    void ({} as Json);
  });
});
