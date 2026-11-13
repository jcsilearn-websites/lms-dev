import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadDotEnv, parseOwnerEnv } from '../src/config/env';
import { newId } from '../src/core/uuid';
import { connectionConfig } from '../src/db/connection';
import { deleteTenantCascade } from '../src/db/dev-cleanup';

// Step 11 benchmark: the gradebook calculation in ONE statement (docs/benchmarks.md, "Step 11"). A throwaway college
// ("bench-<random>") with 500 and then 1,200 learners x 60 items (50 manual columns, 5 quizzes, 5 assignments, five categories,
// drop-lowest and zero-after-due policies on) is created WITHOUT statistics (the planner believes every table has one row: the
// state of a freshly loaded college, see CLAUDE.md "Planner lesson") and measured in that state first, then after ANALYZE.
//
//   DATABASE_URL=<owner url of a MIGRATED database> pnpm --filter @lms/backend run bench:gradebook
//
// The college is deleted in a `finally` block. It runs the function as the APP role with the college set, like the API does.

const ITEMS = { manual: 50, quizzes: 5, assignments: 5 };
const SIZES = (process.env.GRADEBOOK_BENCH_SIZES ?? '500,1200').split(',').map(Number);
const RUNS = Number(process.env.GRADEBOOK_BENCH_RUNS ?? 5);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const appUrl = process.env.DATABASE_APP_URL ?? '';
  const owner = new pg.Client(
    connectionConfig(ownerEnv.DATABASE_URL, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
  );
  await owner.connect();
  const app = new pg.Client(connectionConfig(appUrl, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA));
  await app.connect();
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  for (const learners of SIZES) {
    const suffix = randomBytes(4).toString('hex');
    const slug = `bench-${suffix}`;
    const tenantId = newId();
    try {
      // ---------------------------------------------------------------- the college (no statistics afterwards)
      await owner.query('BEGIN');
      await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        `Bench ${suffix}`,
      ]);
      const teacher = newId();
      const approver = newId();
      await owner.query(
        `INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, 'Bench Teacher'), ($3, $4, 'Bench Admin')`,
        [teacher, `t@${slug}.test`, approver, `a@${slug}.test`],
      );
      await owner.query(
        `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES (lms.uuid_v7(), $1, $2, 'member'), (lms.uuid_v7(), $1, $3, 'institution_admin')`,
        [tenantId, teacher, approver],
      );
      await owner.query(
        `INSERT INTO lms.users (id, email, display_name)
         SELECT lms.uuid_v7(), 'l' || g || '@${slug}.test', 'Learner ' || g FROM generate_series(1, ${learners}) g`,
      );
      await owner.query(
        `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
         SELECT lms.uuid_v7(), $1, u.id, 'member', 'active' FROM lms.users u WHERE u.email LIKE 'l%@${slug}.test'`,
        [tenantId],
      );
      const yearId = newId();
      const termId = newId();
      const courseId = newId();
      const offeringId = newId();
      const moduleId = newId();
      await owner.query(
        `INSERT INTO lms.academic_years (id, tenant_id, label, start_date, end_date) VALUES ($1, $2, 'B', '2026-06-01', '2027-05-31')`,
        [yearId, tenantId],
      );
      await owner.query(
        `INSERT INTO lms.terms (id, tenant_id, academic_year_id, name, start_date, end_date) VALUES ($1, $2, $3, 'T1', '2026-06-01', '2026-11-30')`,
        [termId, tenantId, yearId],
      );
      await owner.query(
        `INSERT INTO lms.courses (id, tenant_id, code, title) VALUES ($1, $2, 'BENCH', 'Bench course')`,
        [courseId, tenantId],
      );
      await owner.query(
        `INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, status) VALUES ($1, $2, $3, $4, 'published')`,
        [offeringId, tenantId, courseId, termId],
      );
      await owner.query(
        `INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published) VALUES ($1, $2, $3, 'M', 'a', true)`,
        [moduleId, tenantId, offeringId],
      );
      await owner.query(
        `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
         SELECT lms.uuid_v7(), m.tenant_id, $2, m.id,
                (CASE WHEN m.user_id = $3 THEN 'instructor' WHEN m.user_id = $4 THEN 'assistant' ELSE 'learner' END)::lms.participation_type, 'manual'
           FROM lms.tenant_memberships m WHERE m.tenant_id = $1`,
        [tenantId, offeringId, teacher, approver],
      );
      // the quizzes and assignments (their settings rows come from the default-row triggers)
      await owner.query(
        `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, published)
         SELECT lms.uuid_v7(), $1, $2, $3, k.kind, k.kind || ' ' || g, 'a' || k.kind || g, true
           FROM (VALUES ('assessment', ${ITEMS.quizzes}), ('assignment', ${ITEMS.assignments})) k(kind, n),
                LATERAL generate_series(1, k.n) g`,
        [tenantId, offeringId, moduleId],
      );
      await owner.query(
        `INSERT INTO lms.attempts (id, tenant_id, assessment_item_id, offering_id, participant_id, attempt_no, status, started_at,
                                   deadline_at, submitted_at, submit_kind, score, max_score, graded_at, released_at)
         SELECT lms.uuid_v7(), a.tenant_id, a.item_id, a.offering_id, p.id, 1, 'graded', now(), now(), now(), 'manual',
                (random() * 10)::numeric(8, 2), 10, now(), now()
           FROM lms.assessments a JOIN lms.course_participants p ON p.tenant_id = a.tenant_id AND p.offering_id = a.offering_id
          WHERE a.tenant_id = $1 AND p.participation = 'learner'`,
        [tenantId],
      );
      await owner.query(
        `INSERT INTO lms.submissions (id, tenant_id, assignment_item_id, offering_id, participant_id, version_no, request_key)
         SELECT lms.uuid_v7(), a.tenant_id, a.item_id, a.offering_id, p.id, 1, gen_random_uuid()
           FROM lms.assignments a JOIN lms.course_participants p ON p.tenant_id = a.tenant_id AND p.offering_id = a.offering_id
          WHERE a.tenant_id = $1 AND p.participation = 'learner'`,
        [tenantId],
      );
      await owner.query(
        `INSERT INTO lms.assignment_grades (tenant_id, assignment_item_id, participant_id, submission_id, raw_score, graded_by, released_at)
         SELECT s.tenant_id, s.assignment_item_id, s.participant_id, s.id, (random() * 100)::numeric(8, 2), $2, now()
           FROM lms.submissions s WHERE s.tenant_id = $1`,
        [tenantId, teacher],
      );
      // the gradebook: five categories, drop-lowest and zero-after-due policies, a scale
      const gb = (
        await owner.query(
          'SELECT id FROM lms.gradebooks WHERE tenant_id = $1 AND offering_id = $2',
          [tenantId, offeringId],
        )
      ).rows[0].id as string;
      await owner.query('DELETE FROM lms.gradebook_categories WHERE tenant_id = $1', [tenantId]);
      await owner.query(
        `INSERT INTO lms.gradebook_categories (id, tenant_id, gradebook_id, name, weight, drop_lowest, missing_policy, position)
         SELECT lms.uuid_v7(), $1, $2, 'C' || g, 20, g % 3, CASE WHEN g % 2 = 0 THEN 'zero_after_due' ELSE 'exclude' END, g
           FROM generate_series(1, 5) g`,
        [tenantId, gb],
      );
      await owner.query(
        `INSERT INTO lms.gradebook_items (id, tenant_id, gradebook_id, category_id, source, title, points, position, released, due_at)
         SELECT lms.uuid_v7(), $1, $2, (SELECT id FROM lms.gradebook_categories WHERE tenant_id = $1 AND name = 'C' || (g % 5 + 1)),
                'manual', 'Manual ' || g, 20, g, true, CASE WHEN g % 4 = 0 THEN now() - interval '1 day' END
           FROM generate_series(1, ${ITEMS.manual}) g`,
        [tenantId, gb],
      );
      await owner.query(
        `WITH n AS (SELECT ci.id, ci.kind, row_number() OVER (ORDER BY ci.id) AS rn
                      FROM lms.content_items ci WHERE ci.tenant_id = $1 AND ci.kind IN ('assessment', 'assignment'))
         INSERT INTO lms.gradebook_items (id, tenant_id, gradebook_id, category_id, source, content_item_id, points, position)
         SELECT lms.uuid_v7(), $1, $2, (SELECT c.id FROM lms.gradebook_categories c WHERE c.tenant_id = $1 AND c.name = 'C' || (n.rn % 5 + 1)),
                n.kind, n.id, CASE WHEN n.kind = 'assignment' THEN 100 ELSE 10 END, 100 + n.rn
           FROM n`,
        [tenantId, gb],
      );
      await owner.query(
        `INSERT INTO lms.manual_marks (tenant_id, item_id, participant_id, points, entered_by)
         SELECT $1, i.id, p.id, (random() * 20)::numeric(8, 2), $2
           FROM lms.gradebook_items i JOIN lms.course_participants p ON p.tenant_id = i.tenant_id
          WHERE i.tenant_id = $1 AND i.source = 'manual' AND p.participation = 'learner' AND random() < 0.9`,
        [tenantId, teacher],
      );
      const scale = newId();
      await owner.query(
        `INSERT INTO lms.grade_scales (id, tenant_id, name, created_by) VALUES ($1, $2, 'Bench', $3)`,
        [scale, tenantId, teacher],
      );
      await owner.query(
        `INSERT INTO lms.grade_scale_bands (tenant_id, scale_id, min_percent, label, is_pass)
         VALUES ($1, $2, 0, 'RA', false), ($1, $2, 50, 'C', true), ($1, $2, 60, 'B', true), ($1, $2, 70, 'B+', true), ($1, $2, 80, 'A', true), ($1, $2, 90, 'A+', true)`,
        [tenantId, scale],
      );
      await owner.query(
        `UPDATE lms.gradebooks SET weighted = true, out_of = 40, scale_id = $2 WHERE id = $1`,
        [gb, scale],
      );
      await owner.query('COMMIT');

      if (process.env.GRADEBOOK_BENCH_SETUP_ONLY === '1') {
        // for EXPLAIN experiments by hand: keep the college, say where it is (clean it with `pnpm db:dev:clean`)
        say(`SETUP ONLY: tenant ${tenantId} offering ${offeringId} teacher ${teacher}`);
        await app.end();
        await owner.end();
        return;
      }
      const items = ITEMS.manual + ITEMS.quizzes + ITEMS.assignments;
      say(`\n=== ${learners} learners x ${items} items (${learners * items} cells) ===`);

      // a COLD pool connection as the app, with the college set
      const timeApp = async (label: string, sql: string, params: unknown[], runs = RUNS) => {
        const t: number[] = [];
        for (let i = 0; i < runs; i++) {
          await app.query('BEGIN');
          await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
          const t0 = performance.now();
          await app.query(sql, params);
          t.push(performance.now() - t0);
          await app.query('ROLLBACK');
        }
        say(
          `${label.padEnd(58)} median ${r2(median(t)).toString().padStart(8)} ms   (runs: ${t.map((x) => Math.round(x)).join(', ')})`,
        );
      };
      const phase = async (name: string) => {
        say(`--- ${name}`);
        await timeApp(
          'compute, all learners, no explanation (the grid)',
          'SELECT count(*) FROM lms.gradebook_compute($1, $2, $3, NULL, false)',
          [tenantId, offeringId, 'staff'],
        );
        await timeApp(
          'compute, all learners, WITH explanations (the lock)',
          'SELECT count(*) FROM lms.gradebook_compute($1, $2, $3, NULL, true)',
          [tenantId, offeringId, 'staff'],
          3,
        );
        await timeApp(
          'grid chunk: 500 learners, JSON built',
          'SELECT lms.gradebook_grid($1, $2, NULL, NULL, NULL, 500)',
          [tenantId, offeringId],
        );
        const one = (
          await owner.query(
            `SELECT id FROM lms.course_participants WHERE tenant_id = $1 AND participation = 'learner' LIMIT 1`,
            [tenantId],
          )
        ).rows[0].id;
        await timeApp(
          'one learner, learner view with explanation (me)',
          'SELECT lms.gradebook_me($1, $2, $3)',
          [
            tenantId,
            (
              await owner.query(
                `SELECT m.user_id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.id = p.membership_id WHERE p.id = $1`,
                [one],
              )
            ).rows[0].user_id,
            offeringId,
          ],
          20,
        );
        await timeApp(
          'one learner, staff explanation',
          'SELECT lms.gradebook_explain($1, $2, $3)',
          [tenantId, offeringId, one],
          20,
        );
        await timeApp(
          'review (problems, excluded, stats: compute twice)',
          'SELECT lms.gradebook_review($1, $2)',
          [tenantId, offeringId],
          3,
        );
        await timeApp(
          'a batch of 500 mark cells + recompute of their rows',
          `SELECT lms.gradebook_marks_save($1, $2, $3, true, 'grid', (SELECT jsonb_agg(jsonb_build_object('itemId', m.item_id, 'participantId', m.participant_id, 'points', '7.5')) FROM (SELECT item_id, participant_id FROM lms.manual_marks WHERE tenant_id = $1 LIMIT 500) m))`,
          [tenantId, teacher, offeringId],
          3,
        );
      };

      await phase('FRESH college, no statistics (what a newly loaded college looks like)');

      // the lock: submit + approve in one transaction each time, then rolled back
      const lockTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await app.query(
          `UPDATE lms.gradebooks SET status = 'submitted', submitted_by = $2, submitted_at = now() WHERE id = $1`,
          [gb, teacher],
        );
        const t0 = performance.now();
        const r = await app.query(
          `SELECT lms.gradebook_review_action($1, $2, $3, 'approve', NULL) AS r`,
          [tenantId, approver, offeringId],
        );
        lockTimes.push(performance.now() - t0);
        if (r.rows[0].r.result !== 'ok')
          throw new Error(`lock refused: ${JSON.stringify(r.rows[0].r)}`);
        await app.query('ROLLBACK');
      }
      say(
        `${'LOCK: approve = compute with explanations + snapshot insert'.padEnd(58)} median ${r2(median(lockTimes)).toString().padStart(8)} ms   (runs: ${lockTimes.map((x) => Math.round(x)).join(', ')})`,
      );

      await owner.query('ANALYZE');
      await phase('after ANALYZE (what autovacuum gives it a minute later)');
    } finally {
      if (process.env.GRADEBOOK_BENCH_SETUP_ONLY !== '1')
        await owner.query('ROLLBACK').catch(() => {});
      if (process.env.GRADEBOOK_BENCH_SETUP_ONLY !== '1')
        await deleteTenantCascade(owner, tenantId).catch((e) => console.error('cleanup failed', e));
    }
  }
  await app.end();
  await owner.end();
  console.log(`\n${lines.length} lines`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
