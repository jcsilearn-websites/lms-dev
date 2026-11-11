// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import {
  addAssessment,
  addQuestion,
  type Exam,
  exam,
  fixed,
  posOf,
  q,
  readAttempt,
  startAttempt,
} from './assessments-helpers';
import type { TestClient } from './client';
import {
  errorCode,
  type Json,
  loginAs,
  ok,
  PNG,
  type Structure,
  structure,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// Step 9: the hardening of the definer functions (grants, search_path, columns), what lms_app may and may not write,
// isolation between colleges, and the images of questions (course scoped files, learner download only via an attempt).

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
  A = await createAuthFixture(owner, 'af-a');
  B = await createAuthFixture(owner, 'af-b');
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
  'assessment_start',
  'attempt_read',
  'attempt_save',
  'attempt_submit',
  'assessment_me',
  'attempt_result',
  'assessment_sweep',
  'question_imports_purge',
];

describe('the definer functions of step 9', () => {
  it('are SECURITY DEFINER, pinned to search_path = lms, pg_temp, owned by the migration role, EXECUTE for lms_app only', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
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
    }
  });

  it('keep the internal finalizer out of reach of lms_app, and pin every helper function too', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.proconfig, has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.proname IN ('attempts_finalize', 'assessment_default_row', 'assessment_draw',
              'assessment_effective_close', 'results_visible', 'norm_text', 'score_answer', 'assessment_final_scores')`,
    );
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.pub, r.proname).toBe(false);
      expect(r.proconfig, r.proname).toContain('search_path=lms, pg_temp');
    }
    expect(rows.find((r) => r.proname === 'attempts_finalize').app).toBe(false);
    expect(rows.find((r) => r.proname === 'assessment_default_row').app).toBe(false);
    // so lms_app cannot score an attempt of its own choosing by calling it directly
    await expect(
      app.query(
        `SELECT lms.attempts_finalize(ARRAY[gen_random_uuid()], ARRAY[gen_random_uuid()], 'manual')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lms_app can read attempts but write only the grading columns, never the answers, deadline or paper', async () => {
    const priv = async (table: string, column: string, kind: 'UPDATE' | 'INSERT') =>
      (
        await owner.query(`SELECT has_column_privilege('lms_app', $1, $2, $3) AS p`, [
          `lms.${table}`,
          column,
          kind,
        ])
      ).rows[0].p as boolean;
    for (const col of [
      'answer',
      'rev',
      'client_at',
      'flagged',
      'points',
      'option_order',
      'question_version_id',
      'question_id',
    ])
      expect(await priv('attempt_questions', col, 'UPDATE'), `attempt_questions.${col}`).toBe(
        false,
      );
    for (const col of ['score', 'feedback', 'manual_state', 'scored_version_id', 'dropped'])
      expect(await priv('attempt_questions', col, 'UPDATE'), `attempt_questions.${col}`).toBe(true);
    for (const col of [
      'deadline_at',
      'started_at',
      'attempt_no',
      'participant_id',
      'submitted_at',
      'submit_kind',
      'event_count',
    ])
      expect(await priv('attempts', col, 'UPDATE'), `attempts.${col}`).toBe(false);
    for (const [table, col] of [
      ['attempts', 'id'],
      ['attempt_questions', 'attempt_id'],
      ['attempt_events', 'attempt_id'],
      ['question_versions', 'presentation'],
    ] as const) {
      expect(await priv(table, col, 'INSERT'), `${table} insert`).toBe(
        table === 'question_versions',
      );
    }
    const table = async (name: string, kind: string) =>
      (
        await owner.query(`SELECT has_table_privilege('lms_app', $1, $2) AS p`, [
          `lms.${name}`,
          kind,
        ])
      ).rows[0].p as boolean;
    for (const name of [
      'attempts',
      'attempt_questions',
      'attempt_events',
      'regrade_runs',
      'regrade_changes',
      'question_versions',
      'questions',
      'assessments',
    ])
      expect(await table(name, 'DELETE'), `${name} delete`).toBe(false);
    // versions are immutable: no UPDATE of any column
    expect(await priv('question_versions', 'answer_key', 'UPDATE')).toBe(false);
    expect(await priv('question_versions', 'presentation', 'UPDATE')).toBe(false);
  });

  it("do not accept another college's attempt, even with a valid attempt id", async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const mc = await addQuestion(e.instructor.client, e.courseId, q.single('Iso?', ['a', 'b'], 0));
    const item = await addAssessment(e, { slots: [fixed(mc.id)] });
    const s = await startAttempt(e, e.learners[0]!, item.id);
    const uid = e.learners[0]!.userId;
    // the same user id, but the tenant of the OTHER college: nothing is found, nothing is written
    const call = async (sqlText: string, params: unknown[]) =>
      (await app.query(sqlText, params)).rows[0].r;
    expect(
      await call(`SELECT lms.attempt_read($1, $2, $3, $4, 30) AS r`, [
        B.tenantId,
        uid,
        e.offeringId,
        s.attemptId,
      ]),
    ).toEqual({ result: 'not_found' });
    expect(
      await call(`SELECT lms.attempt_submit($1, $2, $3, $4) AS r`, [
        B.tenantId,
        uid,
        e.offeringId,
        s.attemptId,
      ]),
    ).toEqual({ result: 'not_found' });
    expect(
      await call(`SELECT lms.attempt_save($1, $2, $3, $4, '[]', '[]', 30) AS r`, [
        B.tenantId,
        uid,
        e.offeringId,
        s.attemptId,
      ]),
    ).toEqual({ result: 'not_found' });
    expect(
      (await owner.query('SELECT status FROM lms.attempts WHERE id = $1', [s.attemptId])).rows[0]
        .status,
    ).toBe('in_progress');
    // and a user of the right college who is not the learner cannot read it either
    const other = await exam(owner, t, A, admin, st, 1);
    expect(
      await call(`SELECT lms.attempt_read($1, $2, $3, $4, 30) AS r`, [
        A.tenantId,
        other.learners[0]!.userId,
        e.offeringId,
        s.attemptId,
      ]),
    ).toEqual({ result: 'not_found' });
  });

  it('the other college sees none of it: no questions, no assessments, no attempts', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const mc = await addQuestion(
      e.instructor.client,
      e.courseId,
      q.single('Hidden?', ['a', 'b'], 0),
    );
    const item = await addAssessment(e, { slots: [fixed(mc.id)] });
    await startAttempt(e, e.learners[0]!, item.id);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [B.tenantId]);
      for (const table of [
        'questions',
        'question_versions',
        'question_tags',
        'assessments',
        'assessment_slots',
        'attempts',
        'attempt_questions',
        'attempt_events',
        'regrade_runs',
        'question_imports',
      ])
        expect((await client.query(`SELECT 1 FROM lms.${table}`)).rows, table).toHaveLength(0);
      // and cannot write a row for the other college
      await expect(
        client.query(
          `INSERT INTO lms.questions (id, tenant_id, course_id, current_version_id, created_by) VALUES (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
          [A.tenantId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const adminB = await loginAs(t, B.host, B.adminEmail);
    expect((await adminB.get(`/courses/${e.courseId}/questions`)).statusCode).toBe(404);
    expect(
      (await adminB.get(`/offerings/${e.offeringId}/items/${item.id}/assessment/analysis`))
        .statusCode,
    ).toBe(404);
  });
});

describe('scope: course routes', () => {
  it('an outsider gets 404 course_not_found, an assistant is refused the managing routes', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const stranger = (await exam(owner, t, A, admin, st, 1)).instructor.client;
    const U = '00000000-0000-7000-8000-000000000000';
    const probes: [string, string, Json?][] = [
      ['GET', `/courses/${e.courseId}/questions`],
      ['GET', `/courses/${e.courseId}/question-tags`],
      ['GET', `/courses/${e.courseId}/questions/${U}`],
      ['POST', `/courses/${e.courseId}/questions`, q.essay('x')],
      ['PUT', `/courses/${e.courseId}/questions/${U}`, q.essay('x')],
      ['POST', `/courses/${e.courseId}/questions/${U}/archive`],
      ['GET', `/courses/${e.courseId}/question-imports/${U}`],
      ['POST', `/courses/${e.courseId}/files`, { name: 'a.png', size: 10 }],
    ];
    for (const [method, url, body] of probes) {
      const r = await stranger.request(method, url, body ? { body } : {});
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(errorCode(r), `${method} ${url}`).toBe('course_not_found');
    }
    const manage = probes.filter(([m]) => m !== 'GET');
    for (const [method, url, body] of manage) {
      const r = await e.assistant.client.request(method, url, body ? { body } : {});
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    // a second offering of the SAME course: its instructor manages the same bank
    const second = await exam(owner, t, A, admin, st, 0);
    void second;
  });

  it('an instructor of ANOTHER offering of the same course shares the bank', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const sister = await ok(
      await admin.post('/offerings', { courseId: e.courseId, termId: st.termId, label: 'evening' }),
    );
    const other = e.assistant; // reuse a member: make them an instructor of the sister offering only
    ok(
      await admin.post(`/offerings/${sister.id}/participants`, {
        userId: other.userId,
        participation: 'instructor',
      }),
    );
    // they were an assistant in the first offering and are an instructor in the sister: the bank lets them manage
    const made = await addQuestion(other.client, e.courseId, q.single('Shared?', ['a', 'b'], 0));
    expect(
      (await e.instructor.client.get(`/courses/${e.courseId}/questions/${made.id}`)).statusCode,
    ).toBe(200);
  });
});

describe('question images: course scoped files, referenced by versions', () => {
  async function uploadImage(c: TestClient, courseId: string, name = 'diagram.png'): Promise<Json> {
    const req = ok(await c.post(`/courses/${courseId}/files`, { name, size: PNG.length }));
    const put = await c.request('PUT', req.upload.url, {
      body: PNG,
      headers: { ...req.upload.headers, 'content-length': String(PNG.length) },
    });
    expect(put.statusCode, put.body).toBe(204);
    return ok(await c.post(`/files/${req.file.id}/confirm`));
  }

  it('accepts only PNG / JPEG images, and the file is not purged while a question uses it', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const c = e.instructor.client;
    expect(
      (await c.post(`/courses/${e.courseId}/files`, { name: 'notes.pdf', size: 10 })).statusCode,
    ).toBe(400);
    const img = await uploadImage(c, e.courseId);
    expect(img.status).toBe('ready');
    const made = await addQuestion(
      c,
      e.courseId,
      q.single('What does the diagram show?', ['a', 'b'], 0, {
        images: [{ fileId: img.id, alt: 'A diagram' }],
      }),
    );
    expect(made.images).toEqual([{ fileId: img.id, alt: 'A diagram' }]);
    // age it past the grace period: still referenced by the version, so the purge leaves it alone
    await owner.query(
      `UPDATE lms.files SET created_at = now() - interval '3 days', confirmed_at = now() - interval '3 days' WHERE id = $1`,
      [img.id],
    );
    await owner.query(`SELECT * FROM lms.files_purge(interval '24 hours', 100)`);
    expect(
      (await owner.query('SELECT 1 FROM lms.files WHERE id = $1', [img.id])).rows,
    ).toHaveLength(1);
    // an unreferenced one of the same age IS purged (so the check above is not vacuous)
    const orphan = await uploadImage(c, e.courseId, 'orphan.png');
    await owner.query(
      `UPDATE lms.files SET created_at = now() - interval '3 days', confirmed_at = now() - interval '3 days' WHERE id = $1`,
      [orphan.id],
    );
    await owner.query(`SELECT * FROM lms.files_purge(interval '24 hours', 100)`);
    expect(
      (await owner.query('SELECT 1 FROM lms.files WHERE id = $1', [orphan.id])).rows,
    ).toHaveLength(0);
    // somebody else's pending / foreign file cannot be attached
    const stranger = await uploadImage(e.assistant.client, e.courseId).catch(() => null);
    expect(stranger).toBeNull(); // assistants cannot upload to the bank at all
    const bad = await c.post(
      `/courses/${e.courseId}/questions`,
      q.single('x', ['a', 'b'], 0, {
        images: [{ fileId: '0194c000-0000-7000-8000-000000000000', alt: 'x' }],
      }),
    );
    expect(errorCode(bad)).toBe('invalid_file');
  });

  it('a learner downloads an image only through THEIR attempt that shows it; instructors through the bank', async () => {
    const e = await exam(owner, t, A, admin, st, 2);
    const c = e.instructor.client;
    const img = await uploadImage(c, e.courseId);
    const made = await addQuestion(
      c,
      e.courseId,
      q.single('Look at the picture', ['a', 'b'], 0, {
        images: [{ fileId: img.id, alt: 'picture' }],
      }),
    );
    const plain = await addQuestion(c, e.courseId, q.single('No picture', ['a', 'b'], 0));
    const withPic = await addAssessment(e, { slots: [fixed(made.id)] });
    const without = await addAssessment(e, { slots: [fixed(plain.id)] });
    const [l1, l2] = e.learners as [Exam['learners'][number], Exam['learners'][number]];
    const s1 = await startAttempt(e, l1, withPic.id);
    const a1 = await readAttempt(e, l1, s1.attemptId);
    expect(a1.questions[0].images).toEqual([{ fileId: img.id, alt: 'picture' }]);
    posOf(a1, 'Look at the picture');
    const url = (attemptId: string) =>
      `/offerings/${e.offeringId}/attempts/${attemptId}/files/${img.id}`;
    const target = ok(await l1.client.get(url(s1.attemptId)));
    expect(target.inline).toBe(true);
    expect(target.url).toContain('/api/storage/download/');
    // another learner cannot use someone else's attempt id; nor an attempt of their own that does not show it
    expect((await l2.client.get(url(s1.attemptId))).statusCode).toBe(404);
    const s2 = await startAttempt(e, l2, without.id);
    expect((await l2.client.get(url(s2.attemptId))).statusCode).toBe(404);
    // instructors reach the same image through the bank
    const viaBank = ok(await c.get(`/courses/${e.courseId}/questions/${made.id}/files/${img.id}`));
    expect(viaBank.url).toContain('/api/storage/download/');
    expect(
      (
        await e.learners[0]!.client.get(
          `/courses/${e.courseId}/questions/${made.id}/files/${img.id}`,
        )
      ).statusCode,
    ).toBe(404);
  });
});
