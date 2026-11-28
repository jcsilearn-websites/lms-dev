import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, totpStep } from '../src/core/totp';
import { removeDemo } from '../src/demo/remove';
import { openRuntime, readState } from '../src/demo/runtime';
import { personaOf, type SeedResult, seedDemo } from '../src/demo/seed';
import { attachLecture, placeholderClip } from '../src/demo/video';
import { testEnv } from './app';
import { createAuthFixture, getTestDatabases, resetLms, testOwnerPool } from './support';
import { assertFfmpeg } from './video-helpers';

// THE DEMO COLLEGE (pnpm demo:seed / demo:reset / demo:video): the real commands against the real database, API routes, job
// handlers and ffmpeg. Seeded twice: the second seed refuses and changes nothing; a reset leaves the same college again and
// touches no other college. Runs alone (it ages dates and switches history triggers off while it removes).

const SLUG = 'demo-testcollege';
const PASSWORD = 'demo-test-password-1';

let owner: pg.Pool;
let env: Record<string, string>;
let first: SeedResult;
let dir: string;
let bystander: Record<string, number>;
/** measured as soon as the first seed is done: later tests sign in (security mail) and attach videos */
let seeded: Record<string, unknown>;
let queuedAfterSeed: number;
let counted: Awaited<ReturnType<typeof inventory>>;

/** Rows of one college in every table that has a tenant_id (the whole database, not a list somebody has to keep). */
async function rowsOf(tenantId: string): Promise<Record<string, number>> {
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'lms' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of rows) {
    const n = await owner.query(
      `SELECT count(*)::int AS n FROM lms.${table_name} WHERE tenant_id = $1`,
      [tenantId],
    );
    if (n.rows[0].n) out[table_name] = n.rows[0].n;
  }
  return out;
}

const SHAPE = `
  SELECT (SELECT count(*)::int FROM lms.tenant_memberships WHERE tenant_id = $1 AND role = 'institution_admin') AS admins,
         (SELECT count(*)::int FROM lms.tenant_memberships WHERE tenant_id = $1) AS members,
         (SELECT count(*)::int FROM lms.course_participants WHERE tenant_id = $1 AND participation = 'learner') AS enrolments,
         (SELECT count(*)::int FROM lms.courses WHERE tenant_id = $1) AS courses,
         (SELECT count(*)::int FROM lms.content_items WHERE tenant_id = $1 AND kind = 'video') AS lectures,
         (SELECT count(*)::int FROM lms.video_assets WHERE tenant_id = $1 AND status = 'ready') AS ready_videos,
         (SELECT count(*)::int FROM lms.questions WHERE tenant_id = $1) AS questions,
         (SELECT count(*)::int FROM lms.attempts WHERE tenant_id = $1 AND status = 'graded') AS graded_attempts,
         (SELECT count(*)::int FROM lms.submissions WHERE tenant_id = $1) AS submissions,
         (SELECT count(*)::int FROM lms.assignment_grades WHERE tenant_id = $1 AND released_at IS NOT NULL) AS released,
         (SELECT count(*)::int FROM lms.assignment_grades WHERE tenant_id = $1 AND released_at IS NULL) AS unreleased,
         (SELECT count(*)::int FROM lms.rubrics WHERE tenant_id = $1) AS rubrics,
         (SELECT array_agg(status::text ORDER BY status::text) FROM lms.gradebooks WHERE tenant_id = $1) AS gradebooks`;
const shape = async (tenantId: string) => (await owner.query(SHAPE, [tenantId])).rows[0];

const tenantIdOf = async () =>
  (await owner.query('SELECT id FROM lms.tenants WHERE slug = $1', [SLUG])).rows[0]?.id as
    | string
    | undefined;

beforeAll(async () => {
  assertFfmpeg();
  owner = testOwnerPool(3);
  await resetLms();
  const other = await createAuthFixture(owner, 'demo-bystander');
  dir = mkdtempSync(path.join(os.tmpdir(), 'lms-demo-'));
  const dbs = getTestDatabases();
  const base = testEnv();
  env = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'test',
    DATABASE_URL: dbs.ownerUrl,
    DATABASE_APP_URL: dbs.appUrl,
    DB_SSL: dbs.ssl,
    MFA_ENFORCEMENT: 'required',
    STORAGE_SIGNING_SECRET: base.STORAGE_SIGNING_SECRET as string,
    STORAGE_LOCAL_DIR: path.join(dir, 'storage'),
    VIDEO_WORK_DIR: path.join(dir, 'work'),
    DEMO_STATE_DIR: path.join(dir, 'state'),
    VIDEO_UPLOAD_CHUNK_BYTES: '262144',
  };
  first = await seedDemo({ slug: SLUG, env, password: PASSWORD, log: () => {} });
  seeded = await shape(first.tenantId);
  counted = await inventory(first.tenantId);
  queuedAfterSeed = (
    await owner.query(
      "SELECT count(*)::int AS n FROM lms.email_outbox WHERE tenant_id = $1 AND status = 'queued'",
      [first.tenantId],
    )
  ).rows[0].n;
  bystander = await rowsOf(other.tenantId);
}, 600_000);

afterAll(async () => {
  await owner.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Everything the seed makes, counted in the database. */
async function inventory(tenantId: string) {
  const one = async (sql: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM ${sql}`, [tenantId])).rows[0].n as number;
  const rows = async (sql: string) => (await owner.query(sql, [tenantId])).rows;
  const mine = (table: string, extra = '') => one(`lms.${table} WHERE tenant_id = $1 ${extra}`);
  return {
    people: {
      accounts: await mine('tenant_memberships', "AND status = 'active'"),
      admins: await mine('tenant_memberships', "AND role = 'institution_admin'"),
      studentProfiles: await mine('member_profiles', "AND profile_type = 'student'"),
      facultyProfiles: await mine('member_profiles', "AND profile_type = 'faculty'"),
    },
    // DIFFERENT people by what they do in a course
    roles: await rows(
      `SELECT participation::text AS role, count(DISTINCT membership_id)::int AS people, count(*)::int AS enrolments
         FROM lms.course_participants WHERE tenant_id = $1 AND status = 'active' GROUP BY 1 ORDER BY 1`,
    ),
    structure: {
      departments: await mine('departments'),
      programs: await mine('programs'),
      batches: await mine('batches'),
      sections: await mine('sections'),
      academicYears: await mine('academic_years'),
      terms: await mine('terms'),
      gradeScales: await mine('grade_scales'),
      gradeBands: await mine('grade_scale_bands'),
      courses: await mine('courses'),
      publishedOfferings: await mine('course_offerings', "AND status = 'published'"),
      modules: await mine('content_modules'),
    },
    content: await rows(
      `SELECT c.code, i.kind::text AS kind, count(*)::int AS items
         FROM lms.content_items i
         JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
         JOIN lms.course_offerings o ON o.tenant_id = m.tenant_id AND o.id = m.offering_id
         JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
        WHERE i.tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    work: (
      await rows(
        `SELECT title FROM lms.content_items WHERE tenant_id = $1 AND kind IN ('assessment', 'assignment')
          ORDER BY title`,
      )
    ).map((r) => r.title),
    assessed: {
      questions: await mine('questions'),
      quizSlots: await mine('assessment_slots'),
      rubrics: await mine('rubrics'),
      assignmentsWithRubric: await mine('assignments', 'AND rubric_version_id IS NOT NULL'),
      gradebookCategories: await mine('gradebook_categories'),
      gradebookItems: await mine('gradebook_items'),
      manualMarks: await mine('manual_marks'),
    },
    history: {
      attempts: await mine('attempts', "AND status = 'graded'"),
      submissions: await mine('submissions'),
      handedInFiles: await mine('submission_files'),
      gradesReleased: await mine('assignment_grades', 'AND released_at IS NOT NULL'),
      gradesWaiting: await mine('assignment_grades', 'AND released_at IS NULL'),
      progressRows: await mine('item_progress'),
    },
    flagged: await rows(
      `SELECT c.code, count(*)::int AS learners FROM lms.atrisk_flags($1, now()) f
         JOIN lms.course_offerings o ON o.id = f.offering_id
         JOIN lms.courses c ON c.id = o.course_id
        WHERE f.f_behind OR f.f_missed OR f.f_low OR f.f_inactive GROUP BY 1 ORDER BY 1`,
    ),
  };
}

describe('the seed', () => {
  it('holds exactly the people and objects the walkthrough promises', () => {
    // written out by hand, on purpose: nothing here is computed from the seed's own data
    expect(counted).toEqual({
      people: { accounts: 34, admins: 1, studentProfiles: 30, facultyProfiles: 3 },
      roles: [
        { role: 'assistant', people: 1, enrolments: 1 },
        { role: 'instructor', people: 2, enrolments: 2 },
        { role: 'learner', people: 30, enrolments: 60 },
      ],
      structure: {
        departments: 2,
        programs: 1,
        batches: 1,
        sections: 2,
        academicYears: 1,
        terms: 1,
        gradeScales: 1,
        gradeBands: 6,
        courses: 2,
        publishedOfferings: 2,
        modules: 5,
      },
      content: [
        { code: 'CS201', kind: 'assessment', items: 2 },
        { code: 'CS201', kind: 'assignment', items: 2 },
        { code: 'CS201', kind: 'link', items: 1 },
        { code: 'CS201', kind: 'text', items: 5 },
        { code: 'CS201', kind: 'video', items: 2 },
        { code: 'ME101', kind: 'assessment', items: 1 },
        { code: 'ME101', kind: 'assignment', items: 1 },
        { code: 'ME101', kind: 'text', items: 3 },
        { code: 'ME101', kind: 'video', items: 1 },
      ],
      work: [
        'Assignment 1: free body diagrams',
        'Assignment 1: linked list operations',
        'Assignment 2: a queue from two stacks',
        'Timed quiz: stacks and queues',
        'Unit test 1',
        'Unit test 1',
      ],
      assessed: {
        questions: 14,
        quizSlots: 22,
        rubrics: 2,
        assignmentsWithRubric: 3,
        gradebookCategories: 4,
        gradebookItems: 6,
        manualMarks: 60,
      },
      // 22 of the 30 learners are active (4 fell behind, 4 never came), in two courses
      history: {
        attempts: 44,
        submissions: 44,
        handedInFiles: 12,
        gradesReleased: 22,
        gradesWaiting: 6,
        progressRows: 247,
      },
      flagged: [
        { code: 'CS201', learners: 11 },
        { code: 'ME101', learners: 11 },
      ],
    });
  });

  it('makes a college with the people, courses and history of the walkthrough', async () => {
    const s = await shape(first.tenantId);
    expect(s).toMatchObject({
      admins: 1,
      members: 34,
      enrolments: 60,
      courses: 2,
      lectures: 3,
      ready_videos: 3,
      questions: 14,
      rubrics: 2,
      gradebooks: ['draft', 'submitted'],
    });
    expect(s.graded_attempts).toBeGreaterThan(30);
    expect(s.submissions).toBeGreaterThan(30);
    expect(s.released).toBeGreaterThan(15);
    expect(s.unreleased).toBeGreaterThan(0);
  });

  it('leaves an at-risk list: the learners who never came, fell behind or scored low, and not the demo learner', async () => {
    const { rows } = await owner.query<{
      email: string;
      f_behind: boolean;
      f_missed: boolean;
      f_low: boolean;
      f_inactive: boolean;
    }>(
      `SELECT u.email, bool_or(f.f_behind) AS f_behind, bool_or(f.f_missed) AS f_missed, bool_or(f.f_low) AS f_low,
              bool_or(f.f_inactive) AS f_inactive
         FROM lms.atrisk_flags($1, now()) f JOIN lms.users u ON u.id = f.user_id
        WHERE f.f_behind OR f.f_missed OR f.f_low OR f.f_inactive GROUP BY u.email`,
      [first.tenantId],
    );
    const { rows: learners } = await owner.query<{ email: string }>(
      `SELECT u.email FROM lms.users u JOIN unnest($1::text[]) WITH ORDINALITY AS n (name, i) ON n.name = u.display_name
        ORDER BY n.i`,
      [(await import('../src/demo/data')).LEARNER_NAMES],
    );
    const flags = new Map(rows.map((r) => [r.email, r]));
    for (const [i, { email }] of learners.entries()) {
      const persona = personaOf(i);
      const f = flags.get(email);
      if (persona === 'demo' || persona === 'steady') expect(f, `${persona} ${i}`).toBeUndefined();
      if (persona === 'absent') expect(f).toMatchObject({ f_inactive: true, f_missed: true });
      if (persona === 'behind') expect(f).toMatchObject({ f_behind: true, f_missed: true });
      if (persona === 'low') expect(f).toMatchObject({ f_low: true });
    }
  });

  it('keeps two-step sign-in on: the admin signs in with the printed secret', async () => {
    const runtime = await openRuntime({ slug: SLUG, env });
    try {
      const admin = runtime.browser();
      const password = await admin.signIn(first.state.adminEmail, PASSWORD);
      expect(password.status).toBe(202);
      expect(password.json.step).toBe('totp');
      // a recovery code works too (the fallback of the pre-demo checklist)
      const done = await admin.post('/auth/mfa/verify', {
        recoveryCode: first.state.adminRecoveryCodes[0],
      });
      expect(done.user.email).toBe(first.state.adminEmail);
      // the authenticator secret is the one saved: the next 30-second step is later than the one used at enrolment
      const again = runtime.browser();
      await again.signIn(first.state.adminEmail, PASSWORD);
      const code = hotp(base32Decode(first.state.adminTotpSecret), totpStep(new Date()) + 1);
      expect((await again.post('/auth/mfa/verify', { code })).user.email).toBe(
        first.state.adminEmail,
      );
    } finally {
      await runtime.close();
    }
    expect(readState(env, SLUG)).toEqual(first.state);
  });

  it('writes a student file that the bulk import accepts as it is', async () => {
    const runtime = await openRuntime({ slug: SLUG, env });
    try {
      const admin = runtime.browser();
      await admin.signIn(first.state.adminEmail, PASSWORD);
      await admin.post('/auth/mfa/verify', { recoveryCode: first.state.adminRecoveryCodes[1] });
      const boundary = 'demo-boundary';
      const body = [
        `--${boundary}`,
        'content-disposition: form-data; name="file"; filename="students.csv"',
        'content-type: text/csv',
        '',
        readFileSync(first.importFile, 'utf8'),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const res = await admin.send('POST', '/api/imports?kind=students', Buffer.from(body), {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      });
      expect(res.status, res.text).toBeLessThan(300);
      expect(res.json.counts).toMatchObject({ total: 5, invalid: 0 });
    } finally {
      await runtime.close();
    }
  });

  it('shows the learner their notifications and leaves nothing queued to be e-mailed', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS bell FROM lms.notifications n JOIN lms.users u ON u.id = n.user_id
        WHERE n.tenant_id = $1 AND u.email = $2`,
      [first.tenantId, first.emails.learner],
    );
    expect(rows[0].bell).toBeGreaterThan(0);
    expect(queuedAfterSeed).toBe(0);
  });
});

describe('seeding again and resetting', () => {
  it('a second seed is refused and changes nothing', async () => {
    const before = await rowsOf(first.tenantId);
    await expect(seedDemo({ slug: SLUG, env, log: () => {} })).rejects.toThrow(
      /already exists: run pnpm demo:reset/,
    );
    expect(await rowsOf(first.tenantId)).toEqual(before);
  });

  it('attaches a real file to a lecture item', async () => {
    const before = await owner.query(
      `SELECT video_asset_id FROM lms.content_items WHERE tenant_id = $1 AND title = $2`,
      [first.tenantId, 'Lecture 1: Arrays and linked lists'],
    );
    const done = await attachLecture({
      slug: SLUG,
      env,
      file: placeholderClip(env, 12),
      course: 'CS201',
      item: 'Lecture 1: Arrays and linked lists',
      log: () => {},
    });
    const after = await owner.query(
      `SELECT i.video_asset_id, v.status, v.duration_ms FROM lms.content_items i
         JOIN lms.video_assets v ON v.tenant_id = i.tenant_id AND v.id = i.video_asset_id
        WHERE i.tenant_id = $1 AND i.title = $2`,
      [first.tenantId, 'Lecture 1: Arrays and linked lists'],
    );
    expect(after.rows[0].video_asset_id).not.toBe(before.rows[0].video_asset_id);
    expect(after.rows[0].status).toBe('ready');
    expect(Math.round(after.rows[0].duration_ms / 1000)).toBe(12);
    expect(done.url).toContain('/items/');
  }, 120_000);

  it('removing leaves no row of the college anywhere, and seeding again makes the same college', async () => {
    const folder = path.join(env.STORAGE_LOCAL_DIR as string, first.tenantId);
    expect(existsSync(folder)).toBe(true);

    expect(await removeDemo({ slug: SLUG, env })).toBe(true);
    expect(await tenantIdOf()).toBeUndefined();
    expect(await rowsOf(first.tenantId)).toEqual({});
    expect(existsSync(folder)).toBe(false);
    const left = await owner.query('SELECT count(*)::int AS n FROM lms.users WHERE email LIKE $1', [
      `%@${SLUG}.example`,
    ]);
    expect(left.rows[0].n).toBe(0);
    expect(await removeDemo({ slug: SLUG, env })).toBe(false);

    const second = await seedDemo({ slug: SLUG, env, password: PASSWORD, log: () => {} });
    expect(second.tenantId).not.toBe(first.tenantId);
    expect(await shape(second.tenantId)).toEqual(seeded);
    // and the other college is exactly as it was
    const other = await owner.query("SELECT id FROM lms.tenants WHERE slug = 'demo-bystander'");
    expect(await rowsOf(other.rows[0].id)).toEqual(bystander);
  }, 600_000);
});

describe('the guard', () => {
  const attempts = (override: Record<string, string>, slug = SLUG) => [
    () => seedDemo({ slug, env: { ...env, ...override }, log: () => {} }),
    () => removeDemo({ slug, env: { ...env, ...override } }),
    () =>
      attachLecture({
        slug,
        env: { ...env, ...override },
        file: placeholderClip(env, 12),
        course: 'CS201',
        item: 'x',
        log: () => {},
      }),
  ];
  const refused = async (override: Record<string, string>, why: RegExp, slug?: string) => {
    for (const run of attempts(override, slug)) await expect(run()).rejects.toThrow(why);
  };

  it('refuses production, Cloud Run, a host that is not allowed and a slug without demo-', async () => {
    const before = (await owner.query('SELECT count(*)::int AS n FROM lms.tenants')).rows[0].n;
    await refused({ NODE_ENV: 'production' }, /NODE_ENV is production/);
    await refused({ K_SERVICE: 'lms-api' }, /Cloud Run/);
    const away = (url: string) => url.replace(/@[^/:]+/, '@db.college.example.com');
    await refused({ DATABASE_URL: away(env.DATABASE_URL as string) }, /not on the allowlist/);
    await refused(
      { DATABASE_APP_URL: away(env.DATABASE_APP_URL as string) },
      /not on the allowlist/,
    );
    await refused({}, /must start with "demo-"/, 'alpha-college');
    expect((await owner.query('SELECT count(*)::int AS n FROM lms.tenants')).rows[0].n).toBe(
      before,
    );
  });
});
