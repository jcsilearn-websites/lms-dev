// Seeds a THROWAWAY college for a load test:
//   node loadtest/src/seed.mjs --api http://127.0.0.1:3100 --host bench-lt-ab12.localhost:3100 --learners 1500
//
// The people (one administrator, instructors, learners) and the course structure are inserted straight into the database with the OWNER connection
// (thousands of rows in a few statements; every account shares ONE argon2 hash of the same password, so a sign-in costs what a real one costs). Everything
// a person would do in the browser goes through the real API as a real instructor sign-in: the module, the question bank, an exam, an assignment, a
// video (an ffmpeg test clip, development stacks only). The ids the scenarios need are written to loadtest/.state/<slug>.json (git-ignored; it holds the
// password of the throwaway accounts).
//
// It REFUSES: NODE_ENV=production; a database or API host that is not on the allowlist (this machine, plus LOADTEST_ALLOWED_HOSTS); a slug that does not
// start with `bench-lt-` (so no real-looking college can be created, and `pnpm db:dev:clean` still removes it on a development database); a slug that exists.
//
// Environment: LOADTEST_DATABASE_URL (or DATABASE_URL) = the OWNER connection of the target database; DB_SSL / DB_SSL_CA as everywhere.

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiClient, createTarget, must } from './client.mjs';
import { assertAllowedTarget } from './guard.mjs';
import { Recorder } from './stats.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
export const STATE_DIR = join(ROOT, 'loadtest', '.state');
const requireFromBackend = createRequire(join(ROOT, 'backend', 'package.json'));
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }; // core/password.ts ARGON2_PARAMS: a different cost would be rehashed at the first sign-in

const doc = (...paragraphs) => ({
  type: 'doc',
  content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
});

function loadEnvFile() {
  const file = join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function sslConfig(host) {
  const mode = process.env.DB_SSL ?? 'off';
  if (mode === 'off') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'verify-full' && process.env.DB_SSL_CA)
    return { ca: readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  throw new Error(`DB_SSL=${mode} for ${host}: verify-full needs DB_SSL_CA`);
}

export async function seed(opts) {
  const log = opts.log ?? ((m) => console.log(m));
  const { learners, instructors, slug } = opts;
  if (!/^bench-lt-[a-z0-9]{2,20}$/.test(slug))
    throw new Error('the slug must look like bench-lt-<letters or digits>');
  if (learners < 1 || learners > 20_000) throw new Error('--learners must be 1 to 20000');
  if (instructors < 1 || instructors > 200) throw new Error('--instructors must be 1 to 200');
  if (opts.password.length < 12) throw new Error('the password needs 12+ characters');

  // ---- guards: nothing is touched before they all pass
  const dbUrl = process.env.LOADTEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dbUrl)
    throw new Error(
      'LOADTEST_DATABASE_URL (the OWNER connection of the target database) is not set',
    );
  const dbHost = assertAllowedTarget(dbUrl, { what: 'database' });
  assertAllowedTarget(opts.api, { what: 'API' });
  const pg = requireFromBackend('pg');
  const { hash } = requireFromBackend('@node-rs/argon2');
  const u = new URL(dbUrl);
  const client = new pg.Client({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: sslConfig(dbHost),
    application_name: 'lms-loadtest-seed',
  });
  await client.connect();
  const tenantId = randomUUID();
  const state = {
    slug,
    host: opts.host,
    api: opts.api,
    password: opts.password,
    learners,
    instructors,
    createdAt: new Date().toISOString(),
  };
  try {
    if ((await client.query('SELECT 1 FROM lms.tenants WHERE slug = $1', [slug])).rowCount)
      throw new Error(`the college ${slug} already exists`);
    log(
      `> ${slug}: ${learners} learners, ${instructors} instructors, one administrator (database ${dbHost})`,
    );

    // ---- people and structure, set-based, one transaction
    const passwordHash = await hash(opts.password.normalize('NFKC'), ARGON2);
    await client.query('BEGIN');
    await client.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
      tenantId,
      slug,
      `Load test ${slug}`,
    ]);
    await client.query(
      `INSERT INTO lms.users (id, email, display_name)
       SELECT lms.uuid_v7(), 'admin@${slug}.test', 'Load Admin'
       UNION ALL SELECT lms.uuid_v7(), 'teacher' || g || '@${slug}.test', 'Teacher ' || g FROM generate_series(1, $1::int) g
       UNION ALL SELECT lms.uuid_v7(), 'learner' || g || '@${slug}.test', 'Learner ' || g FROM generate_series(1, $2::int) g`,
      [instructors, learners],
    );
    await client.query(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
       SELECT lms.uuid_v7(), $1, u.id, CASE WHEN u.email LIKE 'admin@%' THEN 'institution_admin' ELSE 'member' END::lms.membership_role, 'active'
         FROM lms.users u WHERE u.email LIKE '%@${slug}.test'`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO lms.user_credentials (user_id, password_hash)
       SELECT u.id, $1 FROM lms.users u WHERE u.email LIKE '%@${slug}.test'`,
      [passwordHash],
    );
    const ids = Object.fromEntries(
      ['year', 'term', 'course', 'offering'].map((k) => [k, randomUUID()]),
    );
    await client.query(
      "INSERT INTO lms.academic_years (id, tenant_id, label, start_date, end_date) VALUES ($1, $2, 'Load', '2026-01-01', '2027-12-31')",
      [ids.year, tenantId],
    );
    await client.query(
      "INSERT INTO lms.terms (id, tenant_id, academic_year_id, name, start_date, end_date) VALUES ($1, $2, $3, 'T1', '2026-01-01', '2027-12-31')",
      [ids.term, tenantId, ids.year],
    );
    await client.query(
      "INSERT INTO lms.courses (id, tenant_id, code, title) VALUES ($1, $2, 'LOAD101', 'Load test course')",
      [ids.course, tenantId],
    );
    await client.query(
      "INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, status) VALUES ($1, $2, $3, $4, 'published')",
      [ids.offering, tenantId, ids.course, ids.term],
    );
    await client.query(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
       SELECT lms.uuid_v7(), m.tenant_id, $2, m.id,
              CASE WHEN u.email LIKE 'teacher%' THEN 'instructor' ELSE 'learner' END::lms.participation_type, 'manual'
         FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email NOT LIKE 'admin@%'`,
      [tenantId, ids.offering],
    );
    await client.query('COMMIT');
    state.tenantId = tenantId;
    state.courseId = ids.course;
    state.offeringId = ids.offering;
    log('> people and structure inserted');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    throw err;
  }
  await client.end();

  // ---- content, through the real API as the first instructor
  const target = createTarget({ baseUrl: opts.api, host: opts.host });
  const recorder = new Recorder();
  const teach = new ApiClient({ target, recorder, name: 'teacher1' });
  if (!(await teach.login(`teacher1@${slug}.test`, opts.password, { record: false })))
    throw new Error(
      'the instructor could not sign in (is the API reachable with this Host, and the rate limit raised?)',
    );
  const O = `/api/offerings/${state.offeringId}`;
  const course = `/api/courses/${state.courseId}`;
  const mod = must(await teach.post(`${O}/modules`, { title: 'Load test' }), 'module');
  must(await teach.patch(`${O}/modules/${mod.id}`, { published: true }), 'show module');

  state.textItemIds = [];
  for (let i = 1; i <= 8; i++) {
    const item = must(
      await teach.post(`${O}/modules/${mod.id}/items`, {
        kind: 'text',
        title: `Reading ${i}`,
        body: doc(`Reading ${i}.`, 'A paragraph of course text.'),
        published: true,
      }),
      'text item',
    );
    state.textItemIds.push(item.id);
  }

  // question bank and the exam
  const questionIds = [];
  for (let n = 1; n <= 40; n++) {
    const q = must(
      await teach.post(`${course}/questions`, {
        type: 'single_choice',
        difficulty: n % 3 === 0 ? 'hard' : 'easy',
        stem: doc(`Question ${n}: which statement is true?`),
        options: [
          { text: doc('The first statement'), correct: true },
          { text: doc('The second statement'), correct: false },
          { text: doc('The third statement'), correct: false },
          { text: doc('The fourth statement'), correct: false },
        ],
        tags: ['load'],
      }),
      'question',
    );
    questionIds.push(q.id);
  }
  const exam = must(
    await teach.post(`${O}/modules/${mod.id}/items`, {
      kind: 'assessment',
      title: 'Load exam',
      published: true,
    }),
    'exam item',
  );
  must(
    await teach.put(`${O}/items/${exam.id}/assessment`, {
      kind: 'exam',
      timeLimitMinutes: 120,
      attemptsAllowed: 20,
      shuffleQuestions: true,
      shuffleOptions: true,
      resultsVisibility: 'immediate',
      answersVisibility: 'never',
    }),
    'exam settings',
  );
  must(
    await teach.put(`${O}/items/${exam.id}/assessment/slots`, {
      slots: questionIds
        .slice(0, 30)
        .map((questionId) => ({ kind: 'fixed', questionId, points: 1 })),
    }),
    'exam slots',
  );
  state.exam = { itemId: exam.id, questions: 30 };

  // the assignment: files and text, resubmission allowed (a second run is a new version, not a refusal)
  const assignment = must(
    await teach.post(`${O}/modules/${mod.id}/items`, {
      kind: 'assignment',
      title: 'Load assignment',
      published: true,
    }),
    'assignment item',
  );
  const day = 86_400_000;
  must(
    await teach.put(`${O}/items/${assignment.id}/assignment`, {
      instructions: doc('Hand in a PDF or paste the text.'),
      dueAt: new Date(Date.now() + 30 * day).toISOString(),
      latePolicy: 'allowed',
      lateCutoffAt: new Date(Date.now() + 60 * day).toISOString(),
      penaltyKind: 'per_day',
      penaltyValue: 10,
      penaltyCap: 30,
      maxPoints: 100,
      passingScore: 40,
      allowFile: true,
      allowText: true,
      maxFiles: 3,
      maxFileMb: 20,
      resubmissionAllowed: true,
    }),
    'assignment settings',
  );
  state.assignment = { itemId: assignment.id };

  // the video (development stacks: ffmpeg on the PATH, the local provider)
  state.video = null;
  if (!opts.noVideo) {
    try {
      state.video = await uploadVideo(teach, O, mod.id, opts.videoSeconds, log);
    } catch (err) {
      log(
        `! no video: ${err.message} (the video scenario will be skipped; use --no-video to silence this)`,
      );
    }
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const file = join(STATE_DIR, `${slug}.json`);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await target.close();
  log(`> state written: ${file}`);
  return { state, file };
}

async function uploadVideo(teach, O, moduleId, seconds, log) {
  const dir = join(ROOT, 'loadtest', '.state', 'video');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `clip-${seconds}s.mp4`);
  if (!existsSync(file)) {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=640x360:r=25:d=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=f=440:d=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '50',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
  }
  const bytes = readFileSync(file);
  const created = must(
    await teach.post(`${O}/videos`, { fileName: 'load.mp4', size: bytes.length }),
    'video upload',
  );
  const chunk = created.upload.chunkBytes;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    must(
      await teach.call('PATCH', `${O}/videos/${created.video.id}/upload`, {
        body: bytes.subarray(offset, offset + chunk),
        headers: {
          'content-type': 'application/offset+octet-stream',
          'upload-offset': String(offset),
        },
      }),
      'video chunk',
    );
  }
  must(await teach.post(`${O}/videos/${created.video.id}/complete`, {}), 'video complete');
  log('> waiting for the transcode ...');
  for (let i = 0; i < 600; i++) {
    const v = must(await teach.get(`${O}/videos/${created.video.id}`), 'video status');
    if (v.status === 'ready') {
      const item = must(
        await teach.post(`${O}/modules/${moduleId}/items`, {
          kind: 'video',
          title: 'Load lecture',
          videoId: created.video.id,
          published: true,
        }),
        'video item',
      );
      return { itemId: item.id, videoId: created.video.id, seconds };
    }
    if (v.status === 'failed')
      throw new Error(`the video failed: ${v.error?.message ?? 'unknown'}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the video was not ready in 10 minutes (is the worker running?)');
}

async function main() {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      host: { type: 'string' },
      slug: { type: 'string' },
      learners: { type: 'string', default: '1500' },
      instructors: { type: 'string', default: '8' },
      password: { type: 'string' },
      'video-seconds': { type: 'string', default: '120' },
      'no-video': { type: 'boolean', default: false },
    },
    strict: true,
  });
  loadEnvFile();
  if (!values.api)
    throw new Error('--api <base URL of the API, e.g. http://127.0.0.1:3100> is required');
  const slug = values.slug ?? `bench-lt-${randomBytes(3).toString('hex')}`;
  const host =
    values.host ??
    `${slug}.localhost${new URL(values.api).port ? `:${new URL(values.api).port}` : ''}`;
  await seed({
    api: values.api,
    host,
    slug,
    learners: Number(values.learners),
    instructors: Number(values.instructors),
    password: values.password ?? `Lt-${randomBytes(12).toString('base64url')}`,
    videoSeconds: Number(values['video-seconds']),
    noVideo: values['no-video'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'seeding failed');
    process.exit(1);
  });
}
