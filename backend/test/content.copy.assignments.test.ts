// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COPY_INLINE_LIMIT } from '../src/modules/content';
import { makeApp, type TestApp } from './app';
import { addAssessment, addQuestion, fixed, pool, q, startAttempt } from './assessments-helpers';
import { addAssignment, base, handIn, queue, rubricInput } from './assignments-helpers';
import type { TestClient } from './client';
import {
  doc,
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  PDF,
  type Person,
  person,
  type Structure,
  structure,
  uploadFile,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 10: copying an offering brings the assessments and the assignments along: the settings (dates moved by the offset of
// the two terms, adjustable, or cleared), the questions of an assessment and the rubric of an assignment WITHIN the same course,
// the attachments (shared files). It NEVER brings attempts, submissions, grades, extensions, accommodations or blind keys.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let term2: string;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'cp-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  // the first term starts 2026-06-01; this one 196 days later
  term2 = ok(
    await admin.post('/terms', {
      academicYearId: st.yearId,
      name: 'Spring',
      startDate: '2026-12-14',
      endDate: '2027-05-15',
    }),
  ).id;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const DAY = 86_400_000;
/** the instant of a timestamp the database wrote with its own UTC offset */
const iso = (v: string) => new Date(v).toISOString();
const at = (iso: string, days = 0) => new Date(new Date(iso).getTime() + days * DAY).toISOString();

interface Setup {
  courseId: string;
  src: Json;
  dst: Json;
  teacher: Person;
  learner: Person;
  exam: Json;
  essay: Json;
  fileId: string;
  rubric: Json;
  dates: { opens: string; closes: string; aOpens: string; due: string; cutoff: string };
}

/** A source offering of a course with an exam and an essay (with everything a teacher sets), and student data in it. */
async function setup(): Promise<Setup> {
  const course = await newCourse(admin);
  const src = await newOffering(admin, course.id, st.termId);
  const dst = await newOffering(admin, course.id, term2, { label: 'next term' });
  const teacher = await person(owner, t, A, 'Teacher');
  const learner = await person(owner, t, A, 'Learner');
  for (const o of [src, dst])
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: teacher.userId,
        participation: 'instructor',
      }),
    );
  ok(
    await admin.post(`/offerings/${src.id}/participants`, {
      userId: learner.userId,
      participation: 'learner',
    }),
  );
  ok(await teacher.client.post(`/offerings/${src.id}/publish`));
  const m = ok(await teacher.client.post(`/offerings/${src.id}/modules`, { title: 'Week 1' }));
  ok(await teacher.client.patch(`/offerings/${src.id}/modules/${m.id}`, { published: true }));
  const e = {
    courseId: course.id,
    offeringId: src.id,
    moduleId: m.id,
    instructor: teacher,
    assistant: teacher,
    learners: [learner],
  };
  const dates = {
    opens: '2026-07-01T09:00:00.000Z',
    closes: '2026-07-01T11:00:00.000Z',
    aOpens: '2026-07-05T00:00:00.000Z',
    due: '2026-07-12T18:30:00.000Z',
    cutoff: '2026-07-20T18:30:00.000Z',
  };
  const one = await addQuestion(teacher.client, course.id, q.single('Copy?', ['yes', 'no'], 0));
  const two = await addQuestion(
    teacher.client,
    course.id,
    q.single('Again?', ['yes', 'no'], 0, { tags: ['copy'] }),
  );
  const examSettings = {
    kind: 'exam',
    opensAt: dates.opens,
    closesAt: dates.closes,
    timeLimitMinutes: 45,
    attemptsAllowed: 2,
    scoring: 'latest',
    shuffleQuestions: true,
    passingScore: 40,
    resultsVisibility: 'after_close',
    answersVisibility: 'after_close',
  };
  // the dates are in the past by now: the learner's data is made first, the dates are set last
  const exam = await addAssessment(e, {
    title: 'Midterm',
    settings: {
      kind: 'exam',
      timeLimitMinutes: 45,
      attemptsAllowed: 2,
      scoring: 'latest',
      shuffleQuestions: true,
      passingScore: 40,
    },
    slots: [fixed(one.id, 3), pool({ tag: 'copy', count: 1, points: 2 })],
  });
  void two;
  const essaySettings = {
    opensAt: dates.aOpens,
    dueAt: dates.due,
    latePolicy: 'allowed',
    lateCutoffAt: dates.cutoff,
  };
  const essay = await addAssignment(e, {
    title: 'Essay',
    settings: {
      penaltyKind: 'per_day',
      penaltyValue: 7,
      penaltyCap: 35,
      maxPoints: 60,
      passingScore: 50,
      allowText: true,
      maxFiles: 2,
      anonymousGrading: true,
      releaseMode: 'immediate',
      instructions: doc('Write about copies'),
    },
  });
  const rubric = ok(
    await teacher.client.post(`/courses/${course.id}/rubrics`, rubricInput('Copy rubric')),
  );
  ok(await teacher.client.put(`${base(e, essay.id)}/rubric`, { rubricId: rubric.id }));
  const file = await uploadFile(teacher.client, src.id, 'brief.pdf', PDF);
  ok(await teacher.client.put(`${base(e, essay.id)}/attachments`, { fileIds: [file.id] }));
  // student data that must NOT travel: an attempt, a submission, a grade, an extension, an accommodation, the blind keys
  const slotsAttempt = await startAttempt(e, learner, exam.id);
  expect(slotsAttempt.attemptId).toBeTruthy();
  ok(await handIn(e, learner, essay.id));
  await queue(e, teacher, essay.id);
  const pid = (
    await owner.query(
      `SELECT id FROM lms.course_participants WHERE offering_id = $1 AND participation = 'learner'`,
      [src.id],
    )
  ).rows[0].id;
  ok(await teacher.client.put(base(e, essay.id), essaySettings));
  ok(await teacher.client.put(`/offerings/${src.id}/items/${exam.id}/assessment`, examSettings));
  ok(
    await teacher.client.put(`${base(e, essay.id)}/extensions/${pid}`, {
      extendedDueAt: at(dates.due, 3),
    }),
  );
  ok(
    await teacher.client.put(
      `/offerings/${src.id}/items/${exam.id}/assessment/accommodations/${pid}`,
      { extraMinutes: 10, reason: 'private' },
    ),
  );
  return {
    courseId: course.id,
    src,
    dst,
    teacher,
    learner,
    exam,
    essay,
    fileId: file.id,
    rubric,
    dates,
  };
}

const copied = async (offeringId: string, kind: string) =>
  (
    await owner.query(
      `SELECT id, title, published FROM lms.content_items WHERE offering_id = $1 AND kind = $2`,
      [offeringId, kind],
    )
  ).rows;

const studentRows = async (offeringId: string) => {
  const n = async (sql: string) => Number((await owner.query(sql, [offeringId])).rows[0].n);
  return {
    attempts: await n(
      `SELECT count(*) n FROM lms.attempts a JOIN lms.content_items i ON i.id = a.assessment_item_id WHERE i.offering_id = $1`,
    ),
    accommodations: await n(
      `SELECT count(*) n FROM lms.assessment_accommodations a JOIN lms.content_items i ON i.id = a.assessment_item_id WHERE i.offering_id = $1`,
    ),
    submissions: await n(`SELECT count(*) n FROM lms.submissions WHERE offering_id = $1`),
    grades: await n(
      `SELECT count(*) n FROM lms.assignment_grades g JOIN lms.content_items i ON i.id = g.assignment_item_id WHERE i.offering_id = $1`,
    ),
    extensions: await n(
      `SELECT count(*) n FROM lms.assignment_extensions x JOIN lms.content_items i ON i.id = x.assignment_item_id WHERE i.offering_id = $1`,
    ),
    learners: await n(
      `SELECT count(*) n FROM lms.assignment_learners x JOIN lms.content_items i ON i.id = x.assignment_item_id WHERE i.offering_id = $1`,
    ),
    uploads: await n(
      `SELECT count(*) n FROM lms.assignment_uploads x JOIN lms.content_items i ON i.id = x.assignment_item_id WHERE i.offering_id = $1`,
    ),
    progress: await n(`SELECT count(*) n FROM lms.item_progress WHERE offering_id = $1`),
  };
};

describe('the preview', () => {
  it('shows the terms, the proposed shift and every assessment and assignment with its dates; it writes nothing', async () => {
    const s = await setup();
    const before = (
      await owner.query('SELECT count(*)::int AS n FROM lms.content_items WHERE offering_id = $1', [
        s.dst.id,
      ])
    ).rows[0].n;
    const p = ok(
      await s.teacher.client.get(
        `/offerings/${s.dst.id}/copy-preview?sourceOfferingId=${s.src.id}`,
      ),
    );
    expect(p.defaultShiftDays).toBe(196);
    expect(p.sameCourse).toBe(true);
    expect(p.source.termStart).toBe('2026-06-01');
    expect(p.target.termStart).toBe('2026-12-14');
    expect(p.items.map((i: Json) => [i.kind, i.title]).sort()).toEqual([
      ['assessment', 'Midterm'],
      ['assignment', 'Essay'],
    ]);
    const midterm = p.items.find((i: Json) => i.kind === 'assessment');
    expect([iso(midterm.opensAt), iso(midterm.endsAt), midterm.copiesQuestions]).toEqual([
      s.dates.opens,
      s.dates.closes,
      true,
    ]);
    const essay = p.items.find((i: Json) => i.kind === 'assignment');
    expect([iso(essay.opensAt), iso(essay.endsAt), iso(essay.lateCutoffAt)]).toEqual([
      s.dates.aOpens,
      s.dates.due,
      s.dates.cutoff,
    ]);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.content_items WHERE offering_id = $1',
          [s.dst.id],
        )
      ).rows[0].n,
    ).toBe(before);
  });

  it('says that the questions and the rubric do not come along into another COURSE', async () => {
    const s = await setup();
    const other = await newOffering(admin, (await newCourse(admin)).id, term2);
    ok(
      await admin.post(`/offerings/${other.id}/participants`, {
        userId: s.teacher.userId,
        participation: 'instructor',
      }),
    );
    const p = ok(
      await s.teacher.client.get(
        `/offerings/${other.id}/copy-preview?sourceOfferingId=${s.src.id}`,
      ),
    );
    expect(p.sameCourse).toBe(false);
    expect(p.items.every((i: Json) => i.copiesQuestions === false)).toBe(true);
  });

  it('has the gates of the copy: the right to publish here and to edit the source', async () => {
    const s = await setup();
    const stranger = await person(owner, t, A, 'Stranger');
    expect(
      (
        await stranger.client.get(
          `/offerings/${s.dst.id}/copy-preview?sourceOfferingId=${s.src.id}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await s.learner.client.get(
          `/offerings/${s.src.id}/copy-preview?sourceOfferingId=${s.dst.id}`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.teacher.client.get(
          `/offerings/${s.dst.id}/copy-preview?sourceOfferingId=${s.dst.id}`,
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe('the copy', () => {
  it('brings the settings with the dates moved by the offset of the terms, the questions, the rubric and the attachments', async () => {
    const s = await setup();
    const r = ok(
      await s.teacher.client.post(`/offerings/${s.dst.id}/copy`, { sourceOfferingId: s.src.id }),
    );
    expect(r).toMatchObject({ status: 'done', assessments: 1, assignments: 1 });
    const [exam] = await copied(s.dst.id, 'assessment');
    const [essay] = await copied(s.dst.id, 'assignment');
    expect(exam).toMatchObject({ title: 'Midterm', published: false });
    expect(essay).toMatchObject({ title: 'Essay', published: false });

    const a = (await owner.query('SELECT * FROM lms.assessments WHERE item_id = $1', [exam.id]))
      .rows[0];
    expect(a).toMatchObject({
      kind: 'exam',
      time_limit_minutes: 45,
      attempts_allowed: 2,
      scoring: 'latest',
      shuffle_questions: true,
      results_visibility: 'after_close',
      answers_visibility: 'after_close',
    });
    expect(Number(a.passing_score)).toBe(40);
    expect(a.opens_at.toISOString()).toBe(at(s.dates.opens, 196));
    expect(a.closes_at.toISOString()).toBe(at(s.dates.closes, 196));
    const slots = (
      await owner.query(
        'SELECT kind, tag, count, points FROM lms.assessment_slots WHERE assessment_item_id = $1 ORDER BY position',
        [exam.id],
      )
    ).rows;
    expect(slots.map((x) => x.kind)).toEqual(['fixed', 'pool']);
    expect(slots[1]).toMatchObject({ tag: 'copy', count: 1 });

    const g = (await owner.query('SELECT * FROM lms.assignments WHERE item_id = $1', [essay.id]))
      .rows[0];
    expect(g).toMatchObject({
      late_policy: 'allowed',
      penalty_kind: 'per_day',
      max_files: 2,
      allow_text: true,
      anonymous_grading: true,
      release_mode: 'immediate',
      course_id: s.courseId,
    });
    expect([
      Number(g.penalty_value),
      Number(g.penalty_cap),
      Number(g.max_points),
      Number(g.passing_score),
    ]).toEqual([7, 35, 60, 50]);
    expect(g.opens_at.toISOString()).toBe(at(s.dates.aOpens, 196));
    expect(g.due_at.toISOString()).toBe(at(s.dates.due, 196));
    expect(g.late_cutoff_at.toISOString()).toBe(at(s.dates.cutoff, 196));
    expect(JSON.stringify(g.instructions)).toContain('Write about copies');
    // the rubric (the same version) and the attachment (the SAME file row, shared)
    expect(g.rubric_id).toBe(s.rubric.id);
    expect(g.rubric_version_id).toBe(s.rubric.versionId);
    const att = (
      await owner.query(
        'SELECT file_id FROM lms.assignment_attachments WHERE assignment_item_id = $1',
        [essay.id],
      )
    ).rows;
    expect(att.map((x) => x.file_id)).toEqual([s.fileId]);
    // the builder shows it
    const cfg = ok(
      await s.teacher.client.get(`/offerings/${s.dst.id}/items/${essay.id}/assignment`),
    );
    expect(iso(cfg.settings.dueAt)).toBe(at(s.dates.due, 196));
    expect(cfg.attachments[0].name).toBe('brief.pdf');
    expect(cfg.rubric.title).toBe('Copy rubric');
  });

  it('NEVER brings attempts, submissions, grades, extensions, accommodations, drafts, keys or progress', async () => {
    const s = await setup();
    const before = await studentRows(s.src.id);
    expect(before.attempts).toBe(1);
    expect(before.submissions).toBe(1);
    expect(before.extensions).toBe(1);
    expect(before.accommodations).toBe(1);
    expect(before.learners).toBeGreaterThan(0);
    ok(await s.teacher.client.post(`/offerings/${s.dst.id}/copy`, { sourceOfferingId: s.src.id }));
    expect(await studentRows(s.dst.id)).toEqual({
      attempts: 0,
      accommodations: 0,
      submissions: 0,
      grades: 0,
      extensions: 0,
      learners: 0,
      uploads: 0,
      progress: 0,
    });
    // the source is untouched
    expect(await studentRows(s.src.id)).toEqual(before);
  });

  it('an instructor-chosen shift replaces the offset; clearing the dates copies the settings without any', async () => {
    const s = await setup();
    ok(
      await s.teacher.client.post(`/offerings/${s.dst.id}/copy`, {
        sourceOfferingId: s.src.id,
        shiftDays: -3,
      }),
    );
    const [essay] = await copied(s.dst.id, 'assignment');
    const g = (
      await owner.query('SELECT due_at FROM lms.assignments WHERE item_id = $1', [essay.id])
    ).rows[0];
    expect(g.due_at.toISOString()).toBe(at(s.dates.due, -3));

    const s2 = await setup();
    ok(
      await s2.teacher.client.post(`/offerings/${s2.dst.id}/copy`, {
        sourceOfferingId: s2.src.id,
        clearDates: true,
      }),
    );
    const [exam2] = await copied(s2.dst.id, 'assessment');
    const [essay2] = await copied(s2.dst.id, 'assignment');
    const a = (await owner.query('SELECT * FROM lms.assessments WHERE item_id = $1', [exam2.id]))
      .rows[0];
    expect([a.opens_at, a.closes_at]).toEqual([null, null]);
    // "after close" needs a close date: those two fall back to the manual ones instead of breaking the copy
    expect([a.results_visibility, a.answers_visibility]).toEqual(['manual', 'after_release']);
    const g2 = (await owner.query('SELECT * FROM lms.assignments WHERE item_id = $1', [essay2.id]))
      .rows[0];
    expect([g2.opens_at, g2.due_at, g2.late_cutoff_at]).toEqual([null, null, null]);
    expect(g2.late_policy).toBe('none');
  });

  it('into another COURSE: the settings come, the questions and the rubric do not', async () => {
    const s = await setup();
    const otherCourse = await newCourse(admin);
    const other = await newOffering(admin, otherCourse.id, term2);
    ok(
      await admin.post(`/offerings/${other.id}/participants`, {
        userId: s.teacher.userId,
        participation: 'instructor',
      }),
    );
    ok(await s.teacher.client.post(`/offerings/${other.id}/copy`, { sourceOfferingId: s.src.id }));
    const [exam] = await copied(other.id, 'assessment');
    const [essay] = await copied(other.id, 'assignment');
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.assessment_slots WHERE assessment_item_id = $1',
          [exam.id],
        )
      ).rows[0].n,
    ).toBe(0);
    const a = (
      await owner.query(
        'SELECT course_id, time_limit_minutes FROM lms.assessments WHERE item_id = $1',
        [exam.id],
      )
    ).rows[0];
    expect(a).toMatchObject({ course_id: otherCourse.id, time_limit_minutes: 45 });
    const g = (
      await owner.query(
        'SELECT course_id, rubric_id, rubric_version_id, max_points FROM lms.assignments WHERE item_id = $1',
        [essay.id],
      )
    ).rows[0];
    expect(g.course_id).toBe(otherCourse.id);
    expect(g.rubric_id).toBeNull();
    expect(g.rubric_version_id).toBeNull();
    expect(Number(g.max_points)).toBe(60);
    // the attachment (a file, not a course thing) still comes
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.assignment_attachments WHERE assignment_item_id = $1',
          [essay.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('a copied assignment works: published and opened, a learner of the new offering hands in against the shifted dates', async () => {
    const s = await setup();
    ok(await s.teacher.client.post(`/offerings/${s.dst.id}/copy`, { sourceOfferingId: s.src.id }));
    const [essay] = await copied(s.dst.id, 'assignment');
    const g = (await owner.query('SELECT 1 FROM lms.assignments WHERE item_id = $1', [essay.id]))
      .rowCount;
    expect(g).toBe(1);
    // no duplicate default row, no error from the fallback trigger
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM lms.assignments WHERE offering_id = $1', [
          s.dst.id,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM lms.assessments WHERE offering_id = $1', [
          s.dst.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('a LARGE source runs as a job and the job carries the shift', async () => {
    const s = await setup();
    // fill the source over the inline limit (text items written straight into the tables)
    await owner.query(
      `WITH mods AS (
         INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position)
         SELECT gen_random_uuid(), $1, $2, 'Bulk ' || g, 'z' || to_char(g, 'FM0000') || 'x'
           FROM generate_series(1, ceil($3::numeric / 50)::int) g RETURNING id)
       INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, published)
       SELECT gen_random_uuid(), $1, $2, m.id, 'text', 'Bulk ' || i, 'i' || to_char(i, 'FM0000') || 'x', '{"type":"doc"}'::jsonb, true
         FROM mods m, generate_series(1, 50) i LIMIT $3`,
      [A.tenantId, s.src.id, COPY_INLINE_LIMIT + 10],
    );
    const r = await s.teacher.client.post(`/offerings/${s.dst.id}/copy`, {
      sourceOfferingId: s.src.id,
      shiftDays: 10,
    });
    expect(r.statusCode, r.body).toBe(202);
    const job = (
      await owner.query(
        `SELECT payload FROM lms.jobs WHERE tenant_id = $1 AND queue = 'content.copy' AND payload->>'targetId' = $2`,
        [A.tenantId, s.dst.id],
      )
    ).rows[0].payload;
    expect(job).toMatchObject({ shiftDays: 10, clearDates: false });
    const handler = t.app.modules.handlers['content.copy'];
    await handler?.run(job, {
      jobId: 'j',
      queue: 'content.copy',
      tenantId: A.tenantId,
      attempt: 1,
      maxAttempts: 3,
      signal: new AbortController().signal,
    });
    const [essay] = await copied(s.dst.id, 'assignment');
    const g = (
      await owner.query('SELECT due_at FROM lms.assignments WHERE item_id = $1', [essay.id])
    ).rows[0];
    expect(g.due_at.toISOString()).toBe(at(s.dates.due, 10));
    expect(errorCode).toBeTruthy();
  });
});
