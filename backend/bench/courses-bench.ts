import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import autocannon from 'autocannon';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv, parseOwnerEnv, resolvePoolMax } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createPasswordHasher } from '../src/core/password';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { deleteTenantCascade } from '../src/db/dev-cleanup';
import { syncApplyStatement } from '../src/modules/courses/courses.repository';

// Step 6 benchmarks over HTTP against the DEV database, with a throwaway tenant ("bench-<random>") that is
// deleted in a `finally` block:
//   1. the learner's outline of a course with 20 modules x 15 items (GET /offerings/:id/outline)
//   2. "my courses" of a learner who is in 8 offerings (GET /me/courses)
//   3. ONE student moving to another section in a college with 10,000 students and 200 offerings:
//      the request, the pending rows it records, and the sync that applies it (vs. the first full sync)
//
//   pnpm --filter @lms/backend run bench:courses

const STUDENTS = 10_000;
const SECTIONS = 10; // 1,000 students each
const OFFERINGS = 200; // each enrols ONE section: 20 offerings per section
const MY_OFFERINGS = 8;

type Row = { reqPerSec: number; p50: number; p99: number; non2xx: number; errors: number };
const toRow = (r: autocannon.Result): Row => ({
  reqPerSec: Math.round(r.requests.average),
  p50: r.latency.p50,
  p99: r.latency.p99,
  non2xx: r.non2xx,
  errors: r.errors,
});
const ms = (t0: number) => Math.round(performance.now() - t0);

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const owner = new pg.Client(
    connectionConfig(ownerEnv.DATABASE_URL, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
  );
  await owner.connect();

  // Earlier runs leave tens of thousands of dead rows (their throwaway colleges are deleted) and an autovacuum
  // that may still be working on them: clear them first so this run measures the sync, not the leftovers. The new
  // college's own data is still created WITHOUT statistics (the case the sync's plan guard exists for).
  for (const t of [
    'course_participants',
    'course_sync_pending',
    'member_profiles',
    'tenant_memberships',
    'users',
    'jobs',
    'offering_sections',
    'course_offerings',
    'courses',
    'audit_log',
  ]) {
    await owner.query(`VACUUM (ANALYZE) lms.${t}`);
  }

  const suffix = randomBytes(4).toString('hex');
  const slug = `bench-${suffix}`;
  const host = `${slug}.localhost`;
  const adminEmail = `admin@${slug}.test`;
  const learnerEmail = `learner@${slug}.test`;
  const password = randomBytes(18).toString('hex');
  const tenantId = newId();
  const adminId = newId();
  const learnerId = newId();
  const hash = await createPasswordHasher({ concurrency: 1 }).hash(password);

  let app: ReturnType<typeof buildApp> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    await owner.query('BEGIN');
    await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
      tenantId,
      slug,
      `Bench ${suffix}`,
    ]);
    for (const [id, email, role, name] of [
      [adminId, adminEmail, 'institution_admin', 'Bench Admin'],
      [learnerId, learnerEmail, 'member', 'Bench Learner'],
    ] as const) {
      await owner.query('INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, $3)', [
        id,
        email,
        name,
      ]);
      await owner.query(
        'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [newId(), tenantId, id, role],
      );
      await owner.query(
        'INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, $2)',
        [id, hash],
      );
    }
    // structure
    const deptId = newId();
    const progId = newId();
    const batchId = newId();
    const yearId = newId();
    const termId = newId();
    await owner.query(
      "INSERT INTO lms.departments (id, tenant_id, code, name) VALUES ($1, $2, 'BENCH', 'Bench')",
      [deptId, tenantId],
    );
    await owner.query(
      "INSERT INTO lms.programs (id, tenant_id, department_id, code, name, duration_years) VALUES ($1, $2, $3, 'BP', 'Bench', 4)",
      [progId, tenantId, deptId],
    );
    await owner.query(
      'INSERT INTO lms.batches (id, tenant_id, program_id, admission_year, graduation_year) VALUES ($1, $2, $3, 2023, 2027)',
      [batchId, tenantId, progId],
    );
    await owner.query(
      "INSERT INTO lms.academic_years (id, tenant_id, label, start_date, end_date) VALUES ($1, $2, 'B', '2026-06-01', '2027-05-31')",
      [yearId, tenantId],
    );
    await owner.query(
      "INSERT INTO lms.terms (id, tenant_id, academic_year_id, name, start_date, end_date) VALUES ($1, $2, $3, 'T1', '2026-06-01', '2026-11-30')",
      [termId, tenantId, yearId],
    );
    const sections: string[] = [];
    for (let s = 0; s < SECTIONS; s++) {
      const id = newId();
      sections.push(id);
      await owner.query(
        'INSERT INTO lms.sections (id, tenant_id, batch_id, code) VALUES ($1, $2, $3, $4)',
        [id, tenantId, batchId, `S${s + 1}`],
      );
    }
    // courses and offerings
    await owner.query(
      `INSERT INTO lms.courses (id, tenant_id, code, title)
       SELECT gen_random_uuid(), $1, 'C' || g, 'Course ' || g FROM generate_series(1, ${OFFERINGS}) g`,
      [tenantId],
    );
    await owner.query(
      `INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, status)
       SELECT gen_random_uuid(), $1, c.id, $2, 'published' FROM lms.courses c WHERE c.tenant_id = $1`,
      [tenantId, termId],
    );
    // students (inserting their profiles records every one of them in the sync's pending table)
    await owner.query(
      `INSERT INTO lms.users (id, email, display_name)
       SELECT gen_random_uuid(), 's' || g || '@${slug}.test', 'Student ' || g FROM generate_series(1, ${STUDENTS}) g`,
    );
    await owner.query(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
       SELECT gen_random_uuid(), $1, u.id, 'member', 'active' FROM lms.users u WHERE u.email LIKE 's%@${slug}.test'`,
      [tenantId],
    );
    await owner.query(
      `INSERT INTO lms.member_profiles (id, tenant_id, membership_id, profile_type, register_number, batch_id, section_id)
       SELECT gen_random_uuid(), m.tenant_id, m.id, 'student', 'R' || rn, $2, ($3::uuid[])[1 + rn % ${SECTIONS}]
         FROM (SELECT m.*, row_number() OVER (ORDER BY m.id) AS rn FROM lms.tenant_memberships m
                WHERE m.tenant_id = $1 AND m.role = 'member' AND m.user_id <> $4) m`,
      [tenantId, batchId, sections, learnerId],
    );
    // every offering enrols ONE section (20 offerings per section)
    await owner.query(
      `INSERT INTO lms.offering_sections (tenant_id, offering_id, section_id)
       SELECT $1, o.id, ($2::uuid[])[1 + (row_number() OVER (ORDER BY o.id))::int % ${SECTIONS}]
         FROM lms.course_offerings o WHERE o.tenant_id = $1`,
      [tenantId, sections],
    );
    await owner.query('COMMIT');

    // the benchmark learner: a student in section 1 (a participant of 20 offerings), 8 of which they will see
    // as MY_OFFERINGS; plus a big offering for the outline
    const bigCourse = newId();
    const bigOffering = newId();
    await owner.query(
      "INSERT INTO lms.courses (id, tenant_id, code, title) VALUES ($1, $2, 'BIG', 'Big course')",
      [bigCourse, tenantId],
    );
    await owner.query(
      "INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, status) VALUES ($1, $2, $3, $4, 'published')",
      [bigOffering, tenantId, bigCourse, termId],
    );
    const learnerMembership = (
      await owner.query(
        'SELECT id FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, learnerId],
      )
    ).rows[0].id as string;
    await owner.query(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
       SELECT gen_random_uuid(), $1::uuid, o.id, $2::uuid, 'learner'::lms.participation_type, 'manual'::lms.participant_source
         FROM (SELECT id FROM lms.course_offerings WHERE tenant_id = $1 AND id <> $3 ORDER BY id LIMIT ${MY_OFFERINGS - 1}) o
       UNION ALL SELECT gen_random_uuid(), $1::uuid, $3::uuid, $2::uuid, 'learner'::lms.participation_type, 'manual'::lms.participant_source`,
      [tenantId, learnerMembership, bigOffering],
    );
    await owner.query(
      `WITH mods AS (
         INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published)
         SELECT gen_random_uuid(), $1, $2, 'Module ' || g, 'm' || to_char(g, 'FM0000') || 'x', true
           FROM generate_series(1, 20) g RETURNING id)
       INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, published)
       SELECT gen_random_uuid(), $1, $2, m.id, 'text', 'Item ' || i, 'i' || to_char(i, 'FM0000') || 'x', '{"type":"doc"}'::jsonb, true
         FROM mods m, generate_series(1, 15) i`,
      [tenantId, bigOffering],
    );

    const env = parseApiEnv({
      ...process.env,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      RATE_LIMIT_MAX: '1000000',
    });
    db = createDb({
      url: env.DATABASE_APP_URL,
      ssl: env.DB_SSL,
      sslCa: env.DB_SSL_CA,
      max: resolvePoolMax(env),
      applicationName: 'lms-bench-courses',
    });
    app = buildApp({ env, db, logger: createLogger(env) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const headers = {
      host,
      origin: `http://${host}`,
      'x-requested-with': 'lms',
      'content-type': 'application/json',
    };
    const login = (email: string) =>
      new Promise<string>((resolve, reject) => {
        const body = JSON.stringify({ email, password });
        const req = request(
          `${base}/api/auth/login`,
          { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } },
          (res) => {
            res.resume();
            res.on('end', () => {
              const c = (res.headers['set-cookie'] ?? []).map((x) => x.split(';')[0]).join('; ');
              res.statusCode === 200
                ? resolve(c)
                : reject(new Error(`login failed: ${res.statusCode}`));
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    const learnerCookie = await login(learnerEmail);
    const adminCookie = await login(adminEmail);

    const run = async (_title: string, path: string, cookie: string): Promise<Row> => {
      const r = await autocannon({
        url: `${base}${path}`,
        connections: 8,
        duration: 8,
        headers: { ...headers, cookie },
      });
      return toRow(r);
    };
    const outline = await run('outline', `/api/offerings/${bigOffering}/outline`, learnerCookie);
    const mine = await run('mine', '/api/me/courses', learnerCookie);

    // ---- 3. the sync at scale
    const modules = app.modules.courses.service;
    const pending = async () =>
      Number(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.course_sync_pending WHERE tenant_id = $1',
            [tenantId],
          )
        ).rows[0].n,
      );
    const participants = async () =>
      Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.course_participants WHERE tenant_id = $1 AND status = 'active' AND source = 'section'",
            [tenantId],
          )
        ).rows[0].n,
      );
    const pendingAtStart = await pending();
    if (process.env.SYNC_PROFILE && Number(process.env.SYNC_PROFILE_AFTER ?? 0) > 0) {
      // SYNC_PROFILE_AFTER=n: apply n batches first, so the profile below sees a participants table that has grown
      await app.modules.courses.service.syncEnrolments(tenantId, {
        batchSize: 200,
        maxBatches: Number(process.env.SYNC_PROFILE_AFTER),
      });
    }
    if (process.env.SYNC_PROFILE) {
      // SYNC_PROFILE=1: per-statement timings and EXPLAIN (ANALYZE, BUFFERS) of ONE batch of 200 members of the FIRST
      // sync (fresh data, no ANALYZE: the planner knows nothing, like a new college). Rolled back; nothing is kept.
      const ids = (
        await owner.query(
          'SELECT membership_id FROM lms.course_sync_pending WHERE tenant_id = $1 ORDER BY membership_id LIMIT 200',
          [tenantId],
        )
      ).rows.map((r) => r.membership_id as string);
      const stop = new Error('rollback');
      const out: string[] = [];
      await db
        .withTenant(tenantId, async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '600s'`); // the app role is limited to 30 s
          await tx.execute(sql`SET LOCAL enable_seqscan = off`); // as syncBatch does
          const t1 = performance.now();
          await tx.execute(syncApplyStatement(tenantId, ids));
          out.push(`apply statement, one batch of ${ids.length} members: ${ms(t1)} ms`);
          throw stop;
        })
        .catch((e) => {
          if (e !== stop) throw e;
        });
      await db
        .withTenant(tenantId, async (tx) => {
          const plan = await tx.execute(
            sql`EXPLAIN (ANALYZE, BUFFERS) ${syncApplyStatement(tenantId, ids)}`,
          );
          out.push(plan.rows.map((r) => String(r['QUERY PLAN'])).join('\n'));
          throw stop;
        })
        .catch((e) => {
          if (e !== stop) throw e;
        });
      writeFileSync(process.env.SYNC_PROFILE_OUT ?? 'sync-profile.txt', out.join('\n\n'));
    }
    let t0 = performance.now();
    if (process.env.SYNC_PROFILE) {
      // per-batch wall time of the first sync (does a batch get slower as the table fills?)
      const times: number[] = [];
      for (;;) {
        const tb = performance.now();
        const n = await modules.syncEnrolments(tenantId, { batchSize: 200, maxBatches: 1 });
        if (n.members === 0) break;
        times.push(ms(tb));
      }
      console.log('PER-BATCH ms:', times.join(' '));
      t0 = performance.now();
    }
    const first = await modules.syncEnrolments(tenantId, {
      batchSize: 200,
      maxBatches: 10_000,
      concurrency: Number(process.env.SYNC_CONCURRENCY ?? 3),
    });
    const firstMs = ms(t0);
    const enrolled = await participants();

    // one student moves from section 1 to section 2 (an administrator, through the API)
    const mover = (
      await owner.query(
        `SELECT u.id AS user_id FROM lms.member_profiles p JOIN lms.tenant_memberships m ON m.id = p.membership_id
         JOIN lms.users u ON u.id = m.user_id WHERE p.tenant_id = $1 AND p.section_id = $2 LIMIT 1`,
        [tenantId, sections[1]],
      )
    ).rows[0].user_id as string;
    t0 = performance.now();
    const moveRes = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ sectionId: sections[2] });
      const req = request(
        `${base}/api/members/${mover}/profile/section`,
        {
          method: 'POST',
          headers: { ...headers, cookie: adminCookie, 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    const moveMs = ms(t0);
    const pendingAfterMove = await pending();
    t0 = performance.now();
    const one = await modules.syncEnrolments(tenantId, { batchSize: 200, maxBatches: 10 });
    const oneMs = ms(t0);
    const after = await participants();

    console.log(
      JSON.stringify(
        {
          db: 'dev (statements cost ~network latency each; the round-trip counts carry over, not the milliseconds)',
          outline_20x15_learner: outline,
          my_courses_in_8_offerings: mine,
          sync: {
            students: STUDENTS,
            offerings: OFFERINGS,
            first_full_sync: {
              pendingAtStart,
              members: first.members,
              batches: first.batches,
              ms: firstMs,
              enrolments: enrolled,
            },
            one_student_moves_section: {
              requestStatus: moveRes,
              requestMs: moveMs,
              pendingAfterMove,
              syncMembers: one.members,
              syncBatches: one.batches,
              syncMs: oneMs,
              enrolmentsChanged: Math.abs(after - enrolled),
            },
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (app) await app.close();
    if (db) await db.close();
    await owner.query('BEGIN');
    await deleteTenantCascade(owner, tenantId);
    await owner.query('COMMIT');
    await owner.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
