import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadDotEnv, parseOwnerEnv } from '../src/config/env';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { createAnalyticsRepository } from '../src/modules/analytics/analytics.repository';
import { createUsageRepository } from '../src/modules/usage/usage.repository';

// Step 12 benchmark on a SCRATCH database ("lms_bench_s12_<random>", created, migrated and dropped here: the dev database is never
// touched): 10,000 students, 200 offerings, one term of activity. It measures
//   1. the rollup refresh: FULL (every learner marked) and INCREMENTAL (1 % changed), in two statistics states: a freshly loaded
//      college without statistics, and after ANALYZE (the planner lesson of steps 8 and 11);
//   2. the DB time of every dashboard / report (target <= 200 ms each), same two states;
//   3. the activity upsert: statements per user and day, and the cost of 10,000 first-of-day writes.
// Everything runs through the same repository statements the API runs (one transaction, one statement per call).
//
//   pnpm --filter @lms/backend run bench:analytics     BENCH_STUDENTS=10000 BENCH_OFFERINGS=200 BENCH_KEEP=1

const STUDENTS = Number(process.env.BENCH_STUDENTS ?? 10_000);
const OFFERINGS = Number(process.env.BENCH_OFFERINGS ?? 200);
const PER_OFFERING = Math.min(STUDENTS, Number(process.env.BENCH_PER_OFFERING ?? 250));
const TEXT_ITEMS = 10;
const TARGET_MS = 200;
const BATCH = Number(process.env.ANALYTICS_ROLLUP_BATCH ?? 500);

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
async function time<T>(runs: number, fn: () => Promise<T>) {
  const t: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = await fn();
    t.push(performance.now() - t0);
  }
  return {
    median: Math.round(median(t) * 10) / 10,
    max: Math.round(Math.max(...t) * 10) / 10,
    last: last as T,
  };
}

function swapDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const base = new URL(ownerEnv.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(base.hostname))
    throw new Error('the benchmark creates a scratch database: localhost only');
  const dbName = `lms_bench_s12_${randomBytes(3).toString('hex')}`;
  const ownerUrl = swapDatabase(ownerEnv.DATABASE_URL, dbName);
  const appBase = process.env.DATABASE_APP_URL;
  if (!appBase) throw new Error('DATABASE_APP_URL is required');
  const appUrl = swapDatabase(appBase, dbName);
  const out: string[] = [];
  const say = (s: string) => {
    out.push(s);
    console.log(s);
  };

  const admin = new pg.Client(
    connectionConfig(
      swapDatabase(ownerEnv.DATABASE_URL, 'postgres'),
      ownerEnv.DB_SSL,
      ownerEnv.DB_SSL_CA,
    ),
  );
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  let owner: pg.Client | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    await runMigrations({
      ownerUrl,
      ssl: ownerEnv.DB_SSL,
      sslCa: ownerEnv.DB_SSL_CA,
      appPassword: decodeURIComponent(new URL(appUrl).password),
    });
    const conn = new pg.Client(connectionConfig(ownerUrl, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA));
    owner = conn;
    await conn.connect();
    const slug = `bench-${randomBytes(3).toString('hex')}`;
    const tenantId = newId();
    const q = (sql: string, p: unknown[] = []) => conn.query(sql, p);

    // ------------------------------------------------------------------ generate the college (triggers off: set-based load)
    const g0 = performance.now();
    await q('BEGIN');
    await q('SET LOCAL session_replication_role = replica');
    await q('INSERT INTO lms.tenants (id, slug, name) VALUES ($1,$2,$3)', [
      tenantId,
      slug,
      'Bench college',
    ]);
    await q(`INSERT INTO lms.users (id, email, display_name)
             SELECT lms.uuid_v7(), 's' || g || '@${slug}.test', 'Student ' || g FROM generate_series(1, ${STUDENTS}) g`);
    const adminUser = newId();
    const teacherUser = newId();
    await q('INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, $3), ($4, $5, $6)', [
      adminUser,
      `admin@${slug}.test`,
      'Admin',
      teacherUser,
      `teacher@${slug}.test`,
      'Teacher',
    ]);
    await q(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
             SELECT lms.uuid_v7(), $1, u.id, CASE WHEN u.id = $2 THEN 'institution_admin' ELSE 'member' END::lms.membership_role, 'active'
               FROM lms.users u WHERE u.email LIKE '%@${slug}.test'`,
      [tenantId, adminUser],
    );
    await q(
      `INSERT INTO lms.academic_years (id, tenant_id, label, start_date, end_date) VALUES (lms.uuid_v7(), $1, 'B', '2026-06-01', '2027-05-31')`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.terms (id, tenant_id, academic_year_id, name, start_date, end_date)
             SELECT lms.uuid_v7(), $1, y.id, 'T1', '2026-06-01', '2027-05-31' FROM lms.academic_years y WHERE y.tenant_id = $1`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.departments (id, tenant_id, code, name) SELECT lms.uuid_v7(), $1, 'D' || g, 'Department ' || g FROM generate_series(1, 5) g`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.programs (id, tenant_id, department_id, code, name, duration_years)
             SELECT lms.uuid_v7(), $1, d.id, 'P' || right(d.code, 1), 'Programme ' || right(d.code, 1), 3 FROM lms.departments d WHERE d.tenant_id = $1`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.batches (id, tenant_id, program_id, admission_year, graduation_year)
             SELECT lms.uuid_v7(), $1, p.id, 2026, 2029 FROM lms.programs p WHERE p.tenant_id = $1`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.sections (id, tenant_id, batch_id, code)
             SELECT lms.uuid_v7(), $1, b.id, 'S' || g FROM lms.batches b, generate_series(1, 8) g WHERE b.tenant_id = $1`,
      [tenantId],
    );
    // profiles: students spread over the 40 sections
    await q(
      `WITH st AS (
               SELECT m.id AS mid, row_number() OVER (ORDER BY m.id) AS rn FROM lms.tenant_memberships m
                JOIN lms.users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.email LIKE 's%@${slug}.test'),
             sec AS (SELECT s.id, s.batch_id, row_number() OVER (ORDER BY s.id) - 1 AS k FROM lms.sections s WHERE s.tenant_id = $1)
             INSERT INTO lms.member_profiles (id, tenant_id, membership_id, profile_type, register_number, batch_id, section_id, department_id)
             SELECT lms.uuid_v7(), $1, st.mid, 'student', 'R' || st.rn, sec.batch_id, sec.id,
                    (SELECT p.department_id FROM lms.batches b JOIN lms.programs p ON p.tenant_id = b.tenant_id AND p.id = b.program_id
                      WHERE b.tenant_id = $1 AND b.id = sec.batch_id)
               FROM st JOIN sec ON sec.k = (st.rn - 1) % 40`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.courses (id, tenant_id, code, title) SELECT lms.uuid_v7(), $1, 'C' || g, 'Course ' || g FROM generate_series(1, ${OFFERINGS}) g`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, status)
             SELECT lms.uuid_v7(), $1, c.id, (SELECT id FROM lms.terms WHERE tenant_id = $1), 'published'
               FROM lms.courses c WHERE c.tenant_id = $1`,
      [tenantId],
    );
    await q(
      `CREATE TEMP TABLE bo AS SELECT id, row_number() OVER (ORDER BY id) AS n FROM lms.course_offerings WHERE tenant_id = '${tenantId}'`,
    );
    await q(`CREATE TEMP TABLE bm AS SELECT id AS mid, user_id, row_number() OVER (ORDER BY id) AS n FROM lms.tenant_memberships m
              WHERE tenant_id = '${tenantId}' AND user_id IN (SELECT id FROM lms.users WHERE email LIKE 's%@${slug}.test')`);
    // learners: offering n gets PER_OFFERING students starting at (n * 50) mod STUDENTS; the teacher teaches every 20th offering
    await q(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source, created_at)
             SELECT lms.uuid_v7(), $1, bo.id, bm.mid, 'learner', 'manual', '2026-06-01'
               FROM bo CROSS JOIN generate_series(0, ${PER_OFFERING - 1}) k
               JOIN bm ON bm.n = ((bo.n * 50 + k) % ${STUDENTS}) + 1`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
             SELECT lms.uuid_v7(), $1, bo.id, (SELECT id FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2), 'instructor', 'manual'
               FROM bo WHERE bo.n % 20 = 0`,
      [tenantId, teacherUser],
    );
    // content: 3 modules per offering; per offering 10 text items, 2 assignments, 1 quiz
    await q(
      `INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published)
             SELECT lms.uuid_v7(), $1, bo.id, 'Module ' || g, 'm' || g || 'x', true FROM bo, generate_series(1, 3) g`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, published, required, completion, created_at)
             SELECT lms.uuid_v7(), $1, m.offering_id, m.id, 'text', 'Item ' || i, 'i' || i || 'x', '{"type":"doc"}'::jsonb, true, true, 'manual',
                    now() - ((i * 7) || ' days')::interval
               FROM lms.content_modules m, generate_series(1, ${TEXT_ITEMS}) i WHERE m.tenant_id = $1 AND m.position = 'm1x'`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, published, required, completion)
             SELECT lms.uuid_v7(), $1, m.offering_id, m.id, 'assignment', 'Assignment ' || i, 'a' || i || 'x', true, true, 'on_submit'
               FROM lms.content_modules m, generate_series(1, 2) i WHERE m.tenant_id = $1 AND m.position = 'm2x'`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, published, required, completion)
             SELECT lms.uuid_v7(), $1, m.offering_id, m.id, 'assessment', 'Quiz 1', 'q1x', true, true, 'on_submit'
               FROM lms.content_modules m WHERE m.tenant_id = $1 AND m.position = 'm3x'`,
      [tenantId],
    );
    // triggers are off: the rows the default-row triggers would have made
    await q(
      `INSERT INTO lms.assignments (tenant_id, item_id, offering_id, course_id, due_at, release_mode)
             SELECT $1, i.id, i.offering_id, o.course_id, now() - ((10 + (row_number() OVER (PARTITION BY i.offering_id ORDER BY i.id)) * 15) || ' days')::interval, 'manual'
               FROM lms.content_items i JOIN lms.course_offerings o ON o.tenant_id = i.tenant_id AND o.id = i.offering_id
              WHERE i.tenant_id = $1 AND i.kind = 'assignment'`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.assessments (tenant_id, item_id, offering_id, course_id, closes_at)
             SELECT $1, i.id, i.offering_id, o.course_id, now() - interval '20 days'
               FROM lms.content_items i JOIN lms.course_offerings o ON o.tenant_id = i.tenant_id AND o.id = i.offering_id
              WHERE i.tenant_id = $1 AND i.kind = 'assessment'`,
      [tenantId],
    );
    await q(`CREATE TEMP TABLE bl AS SELECT p.id AS pid, p.offering_id AS oid, bm.user_id, row_number() OVER (ORDER BY p.id) AS n
               FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
               JOIN bm ON bm.mid = m.id WHERE p.tenant_id = '${tenantId}' AND p.participation = 'learner'`);
    // progress: 40 % of the (learner, text item) pairs are completed over the last 120 days
    await q(
      `INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how, last_activity_at, first_seen_at)
             SELECT $1, bl.pid, i.id, bl.oid, 'completed', now() - ((x.h % 120) || ' days')::interval, 'manual',
                    now() - ((x.h % 120) || ' days')::interval, now() - ((x.h % 120) || ' days')::interval
               FROM bl JOIN lms.content_items i ON i.tenant_id = $1 AND i.offering_id = bl.oid AND i.kind = 'text',
                    LATERAL (SELECT abs(hashtext(bl.pid::text || i.id::text)) AS h) x
              WHERE x.h % 10 < 4
             ON CONFLICT DO NOTHING`,
      [tenantId],
    );
    // submissions: 70 % of learners per assignment; grades for 60 % of those, released
    await q(
      `INSERT INTO lms.submissions (id, tenant_id, assignment_item_id, offering_id, participant_id, version_no, text_body, request_key, submitted_at)
             SELECT lms.uuid_v7(), $1, i.id, bl.oid, bl.pid, 1, 'x', lms.uuid_v7(), now() - ((x.h % 100) || ' days')::interval
               FROM bl JOIN lms.content_items i ON i.tenant_id = $1 AND i.offering_id = bl.oid AND i.kind = 'assignment',
                    LATERAL (SELECT abs(hashtext(bl.pid::text || i.id::text)) AS h) x WHERE x.h % 10 < 7`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.assignment_grades (tenant_id, assignment_item_id, participant_id, submission_id, raw_score, graded_by, graded_at, released_at)
             SELECT $1, s.assignment_item_id, s.participant_id, s.id, 30 + abs(hashtext(s.id::text)) % 70, $2, s.submitted_at + interval '2 days', s.submitted_at + interval '3 days'
               FROM lms.submissions s WHERE s.tenant_id = $1 AND abs(hashtext(s.id::text)) % 10 < 6`,
      [tenantId, teacherUser],
    );
    // quiz attempts: 80 % of learners, graded
    await q(
      `INSERT INTO lms.attempts (id, tenant_id, assessment_item_id, offering_id, participant_id, attempt_no, status, started_at, deadline_at, submitted_at,
                                       submit_kind, score, max_score, pending_manual, graded_at, released_at)
             SELECT lms.uuid_v7(), $1, i.id, bl.oid, bl.pid, 1, 'graded', now() - ((20 + x.h % 60) || ' days')::interval, now() - ((19 + x.h % 60) || ' days')::interval,
                    now() - ((20 + x.h % 60) || ' days')::interval, 'manual', x.h % 11, 10, 0, now() - ((20 + x.h % 60) || ' days')::interval, now() - ((20 + x.h % 60) || ' days')::interval
               FROM bl JOIN lms.content_items i ON i.tenant_id = $1 AND i.offering_id = bl.oid AND i.kind = 'assessment',
                    LATERAL (SELECT abs(hashtext(bl.pid::text || i.id::text)) AS h) x WHERE x.h % 10 < 8`,
      [tenantId],
    );
    // activity: every student active on ~40 of the last 120 local days
    await q(
      `INSERT INTO lms.member_activity_days (tenant_id, user_id, day)
             SELECT $1, bm.user_id, (current_date - d)::date FROM bm, generate_series(0, 119) d
              WHERE abs(hashtext(bm.user_id::text || d::text)) % 3 = 0`,
      [tenantId],
    );
    await q('COMMIT');
    const counts = (
      await q(`SELECT (SELECT count(*) FROM lms.item_progress) AS ip, (SELECT count(*) FROM lms.submissions) AS sub,
                                    (SELECT count(*) FROM lms.attempts) AS att, (SELECT count(*) FROM lms.member_activity_days) AS act,
                                    (SELECT count(*) FROM lms.course_participants WHERE participation = 'learner') AS enr`)
    ).rows[0] as Record<string, string>;
    say(
      `## college: ${STUDENTS} students, ${OFFERINGS} offerings, ${counts.enr} enrolments, ${counts.ip} progress rows, ${counts.sub} submissions, ${counts.att} attempts, ${counts.act} activity days (generated in ${ms(g0)} ms)`,
    );

    db = createDb({
      url: appUrl,
      ssl: ownerEnv.DB_SSL,
      sslCa: ownerEnv.DB_SSL_CA,
      max: 5,
      applicationName: 'lms-bench-analytics',
    });
    const repo = createAnalyticsRepository();
    const usage = createUsageRepository();
    const dbt = db;

    const refreshAll = async (label: string) => {
      const t0 = performance.now();
      let batches = 0;
      for (;;) {
        batches++;
        const left = await dbt.withoutTenant((c) => repo.rollupRun(c, tenantId, BATCH));
        if (left === 0) break;
      }
      const total = ms(t0);
      say(
        `- ${label}: ${total} ms in ${batches} runs of <= ${BATCH} learners (${Math.round(total / Math.max(1, batches))} ms per run)`,
      );
      return total;
    };
    const resetRollups = async () => {
      await q(
        `TRUNCATE lms.rollup_learner_offering, lms.rollup_offering_day, lms.rollup_org_day, lms.rollup_tenant_day, lms.rollup_state, lms.rollup_dirty_participants, lms.rollup_dirty_offerings`,
      );
    };
    const markPercent = async (pct: number) => {
      await q(
        `UPDATE lms.item_progress SET last_activity_at = now() WHERE tenant_id = $1 AND abs(hashtext(participant_id::text)) % 100 < $2`,
        [tenantId, pct],
      );
    };

    const offeringIds = (
      await q('SELECT id FROM lms.course_offerings WHERE tenant_id = $1 ORDER BY id', [tenantId])
    ).rows.map((r: { id: string }) => r.id);
    const teacherOfferings = (
      await q(
        `SELECT offering_id FROM lms.course_participants WHERE tenant_id = $1 AND participation = 'instructor' LIMIT 1`,
        [tenantId],
      )
    ).rows[0] as { offering_id: string };
    const oneLearner = (await q(`SELECT bm.user_id FROM bm LIMIT 1`)).rows[0] as {
      user_id: string;
    };
    const spec = (offeringId: string) => ({
      tenantId,
      userId: teacherUser,
      offeringId,
      viewAll: true,
      accountAllowed: true,
      allowedBy: [] as never[],
    });

    const measureAll = async (state: string) => {
      say(`\n### dashboards, DB time, ${state} (median of 5, max; target <= ${TARGET_MS} ms)`);
      const results: [string, number, number][] = [];
      const add = async (name: string, fn: () => Promise<unknown>) => {
        const r = await time(5, fn);
        results.push([name, r.median, r.max]);
        say(
          `- ${name}: ${r.median} ms (max ${r.max})${r.median > TARGET_MS ? '   <-- OVER TARGET' : ''}`,
        );
      };
      await add('learner dashboard (1 learner of 5 offerings)', () =>
        dbt.withoutTenant((c) => repo.learnerDashboard(c, tenantId, oneLearner.user_id)),
      );
      await add('offering dashboard (250 learners)', () =>
        dbt.withTenant(tenantId, (tx) =>
          repo.offeringDashboard(tx, spec(teacherOfferings.offering_id)),
        ),
      );
      await add('teaching dashboard (10 offerings)', () =>
        dbt.withTenant(tenantId, (tx) => repo.teachingDashboard(tx, tenantId, teacherUser)),
      );
      await add('at-risk page (50 of 250 learners)', () =>
        dbt.withTenant(tenantId, (tx) =>
          repo.atRiskPage(tx, spec(teacherOfferings.offering_id), { limit: 50, after: null }),
        ),
      );
      await add('video engagement', () =>
        dbt.withTenant(tenantId, (tx) =>
          repo.videoEngagement(tx, spec(offeringIds[0] as string), newId()),
        ),
      );
      await add('active users (DAU / WAU / MAU)', () =>
        dbt.withTenant(tenantId, (tx) => repo.activeUsers(tx, tenantId)),
      );
      for (const [id, scope] of [
        ['activity', 'department'],
        ['organisation', 'department'],
        ['organisation', 'section'],
        ['course-health', 'department'],
        ['gradebooks', 'department'],
        ['grading-backlog', 'department'],
        ['at-risk', 'department'],
        ['resources', 'department'],
      ] as const)
        await add(`report ${id}${id === 'organisation' ? ` by ${scope}` : ''}`, () =>
          dbt.withTenant(tenantId, (tx) => repo.reportRows(tx, tenantId, id, { scope, days: 30 })),
        );
      await add('platform usage (1 college, open month)', () =>
        dbt.withoutTenant((c) =>
          usage
            .platformUsage(c, adminUser, `${new Date().toISOString().slice(0, 7)}-01`, {
              '360p': 0.2,
              '480p': 0.3,
              '720p': 0.5,
            })
            .catch(() => []),
        ),
      );
      return results;
    };

    // ------------------------------------------------------------------ 1. rollups, fresh statistics (nothing analysed yet)
    say('\n### rollup refresh');
    say('state A: freshly loaded, NO statistics');
    const fullA = await refreshAll('FULL refresh (every learner marked)');
    await markPercent(1);
    const incA = await refreshAll('INCREMENTAL refresh (1 % of learners changed)');
    await markPercent(10);
    const inc10A = await refreshAll('INCREMENTAL refresh (10 % changed)');
    const t0 = performance.now();
    await dbt.withoutTenant((c) => repo.rollupRun(c, tenantId, BATCH));
    say(`- NOTHING changed (time events + day windows only): ${ms(t0)} ms`);
    if (process.env.BENCH_STOP === 'refresh') return;
    const dashA = await measureAll('state A (no statistics)');

    // ------------------------------------------------------------------ the same after ANALYZE
    await conn.query('ANALYZE');
    say('\nstate B: after ANALYZE');
    await resetRollups();
    const fullB = await refreshAll('FULL refresh');
    await markPercent(1);
    const incB = await refreshAll('INCREMENTAL refresh (1 % changed)');
    const dashB = await measureAll('state B (ANALYZEd)');

    // ------------------------------------------------------------------ 3. activity upsert
    say('\n### activity upsert (activity_touch: one write per user and local day)');
    await q(`DELETE FROM lms.member_activity_days WHERE tenant_id = $1 AND day = current_date`, [
      tenantId,
    ]);
    const users = (await q('SELECT user_id FROM bm LIMIT 10000')).rows.map(
      (r: { user_id: string }) => r.user_id,
    );
    const single = await time(200, () =>
      dbt.withoutTenant((c) =>
        repo.activityTouch(c, tenantId, users[Math.floor(Math.random() * users.length)] as string),
      ),
    );
    say(`- one call (autocommit, 1 statement): median ${single.median} ms, max ${single.max}`);
    await q(`DELETE FROM lms.member_activity_days WHERE tenant_id = $1 AND day = current_date`, [
      tenantId,
    ]);
    const w0 = performance.now();
    const workers = 5;
    let next = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const i = next++;
          if (i >= users.length) return;
          await dbt.withoutTenant((c) => repo.activityTouch(c, tenantId, users[i] as string));
        }
      }),
    );
    const dur = ms(w0);
    say(
      `- ${users.length} first-of-day writes on ${workers} connections: ${dur} ms (${Math.round((users.length * 1000) / dur)} per second); a repeated call for the same user and day writes nothing`,
    );

    // ------------------------------------------------------------------ summary
    say('\n### summary');
    say(
      `- full refresh: ${fullA} ms fresh / ${fullB} ms analysed; incremental 1 %: ${incA} ms / ${incB} ms; 10 %: ${inc10A} ms (fresh)`,
    );
    const over = [
      ...dashA.filter((r) => r[1] > TARGET_MS).map((r) => `${r[0]} (A: ${r[1]} ms)`),
      ...dashB.filter((r) => r[1] > TARGET_MS).map((r) => `${r[0]} (B: ${r[1]} ms)`),
    ];
    say(
      over.length
        ? `- OVER the ${TARGET_MS} ms target: ${over.join('; ')}`
        : `- every dashboard is within ${TARGET_MS} ms in both states`,
    );
    if (process.env.BENCH_STRICT === '1' && over.length) process.exitCode = 1;
  } finally {
    await db?.close().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (process.env.BENCH_KEEP === '1') console.log(`kept scratch database ${dbName}`);
    else {
      await admin
        .query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
        .catch((e) => console.error('drop failed', e));
    }
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
