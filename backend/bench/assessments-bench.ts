import { createHash, randomBytes } from 'node:crypto';
import autocannon from 'autocannon';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv, parseOwnerEnv, resolvePoolMax } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { deleteTenantCascade } from '../src/db/dev-cleanup';

// Step 9 benchmark: the exam-time burst, against the DEV database, with a throwaway college ("bench-<random>") that is
// deleted in a `finally` block (see docs/benchmarks.md, "Step 9"). One college, one 60-minute exam of 50 questions drawn
// from a bank of 300 (three random pools: 20 easy, 20 medium, 10 hard), LEARNERS learners (default 1,500):
//   1. STARTS: every learner starts the exam (the paper is drawn, shuffled and stored by one database call), then every
//      learner reads it (the resume call a page load makes).
//   2. AUTOSAVE, three loads over the same paper: the REALISTIC pattern (each learner changes an answer every 20-40 s,
//      i.e. LEARNERS / 30 saves per second), the WORST CASE (everybody saves every 3 s) and the SATURATION rate (as fast
//      as the machine goes).
//   3. SUBMIT BURST: every learner hands in at once (50 answers scored by the database function).
//   4. AUTO-SUBMIT AND GRADING: a second cohort started on the same exam; its deadline passes with the browsers closed;
//      the sweeper closes and scores LEARNERS attempts x 50 questions in set-based batches (this IS the grading time of
//      1,500 x 50), then a regrade of one question over all attempts, the item analysis and the final scores.
// The college has NO table statistics on purpose (a freshly loaded tenant, see "Planner lesson" in CLAUDE.md), and
// autovacuum is paused on the exam tables so it cannot analyze mid-run and hide a bad plan.
//
//   pnpm --filter @lms/backend run bench:assessments      BENCH_LEARNERS=1500 BENCH_CONNECTIONS=64

const LEARNERS = Number(process.env.BENCH_LEARNERS ?? 1500);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 64);
const REALISTIC_SECONDS = Number(process.env.BENCH_REALISTIC_SECONDS ?? 30);
const WORST_SECONDS = Number(process.env.BENCH_WORST_SECONDS ?? 20);
const SATURATION_SECONDS = Number(process.env.BENCH_SATURATION_SECONDS ?? 15);
const PER_PAPER = 50;

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const secs = (t0: number) => round((performance.now() - t0) / 1000, 2);

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const owner = new pg.Client(
    connectionConfig(ownerEnv.DATABASE_URL, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
  );
  await owner.connect();

  const suffix = randomBytes(4).toString('hex');
  const slug = `bench-${suffix}`;
  const host = `${slug}.localhost`;
  const tenantId = newId();
  const out: string[] = [];
  const say = (s: string) => {
    out.push(s);
    console.log(s);
  };
  const examTables = ['attempts', 'attempt_questions', 'attempt_events', 'item_progress'];

  let app: ReturnType<typeof buildApp> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    for (const t of examTables)
      await owner.query(`ALTER TABLE lms.${t} SET (autovacuum_enabled = false)`);

    // ------------------------------------------------------------------ the college
    await owner.query('BEGIN');
    await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
      tenantId,
      slug,
      `Bench ${suffix}`,
    ]);
    const instructorId = newId();
    await owner.query('INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, $3)', [
      instructorId,
      `teacher@${slug}.test`,
      'Bench Teacher',
    ]);
    await owner.query(
      "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')",
      [newId(), tenantId, instructorId],
    );
    await owner.query(
      `INSERT INTO lms.users (id, email, display_name)
       SELECT lms.uuid_v7(), 'l' || g || '@${slug}.test', 'Learner ' || g FROM generate_series(1, ${LEARNERS}) g`,
    );
    await owner.query(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
       SELECT lms.uuid_v7(), $1, u.id, 'member', 'active' FROM lms.users u WHERE u.email LIKE 'l%@${slug}.test'`,
      [tenantId],
    );
    const yearId = newId();
    const termId = newId();
    await owner.query(
      "INSERT INTO lms.academic_years (id, tenant_id, label, start_date, end_date) VALUES ($1, $2, 'B', '2026-06-01', '2027-05-31')",
      [yearId, tenantId],
    );
    await owner.query(
      "INSERT INTO lms.terms (id, tenant_id, academic_year_id, name, start_date, end_date) VALUES ($1, $2, $3, 'T1', '2026-06-01', '2026-11-30')",
      [termId, tenantId, yearId],
    );
    const courseId = newId();
    const offeringId = newId();
    await owner.query(
      "INSERT INTO lms.courses (id, tenant_id, code, title) VALUES ($1, $2, 'BENCH', 'Bench course')",
      [courseId, tenantId],
    );
    await owner.query(
      "INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, status) VALUES ($1, $2, $3, $4, 'published')",
      [offeringId, tenantId, courseId, termId],
    );
    await owner.query(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
       SELECT lms.uuid_v7(), m.tenant_id, $2, m.id,
              CASE WHEN m.user_id = $3 THEN 'instructor' ELSE 'learner' END::lms.participation_type, 'manual'
         FROM lms.tenant_memberships m WHERE m.tenant_id = $1`,
      [tenantId, offeringId, instructorId],
    );
    // sessions for every learner (the login hashes a password: 1,500 of them would take minutes)
    const learnerRows = (
      await owner.query<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM lms.users u WHERE u.email LIKE 'l%@${slug}.test'`,
      )
    ).rows;
    const tokens: string[] = [];
    const hashes: string[] = [];
    const userIds: string[] = [];
    for (const r of learnerRows) {
      const token = randomBytes(32).toString('base64url');
      tokens.push(token);
      hashes.push(createHash('sha256').update(token).digest('hex'));
      userIds.push(r.id);
    }
    await owner.query(
      `INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at)
       SELECT lms.uuid_v7(), decode(x.h, 'hex'), x.uid, $1, now() + interval '1 day', now() + interval '2 days'
         FROM unnest($2::text[], $3::uuid[]) AS x(h, uid)`,
      [tenantId, hashes, userIds],
    );
    const moduleId = newId();
    await owner.query(
      "INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published) VALUES ($1, $2, $3, 'Exams', 'm1', true)",
      [moduleId, tenantId, offeringId],
    );
    const itemIds = [newId(), newId()];
    for (const [i, id] of itemIds.entries()) {
      await owner.query(
        `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, published, completion)
         VALUES ($1, $2, $3, $4, 'assessment', $5, $6, true, 'on_submit')`,
        [id, tenantId, offeringId, moduleId, i === 0 ? 'Exam A' : 'Exam B', `i${i + 1}`],
      );
    }
    // the bank: 300 questions, a third each easy (single choice), medium (multiple choice with partial credit),
    // hard (numeric and short answer alternating)
    await owner.query(
      `WITH g AS (
         SELECT n, lms.uuid_v7() AS qid, lms.uuid_v7() AS vid, (ARRAY['easy', 'medium', 'hard'])[1 + n % 3] AS diff
           FROM generate_series(1, 300) n),
       opts AS (
         SELECT g.n, jsonb_agg(jsonb_build_object('id', substr(md5(random()::text || g.n || o), 1, 12),
                  'text', jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object('type', 'paragraph',
                           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Option ' || o)))))) ORDER BY o) AS options
           FROM g, generate_series(1, 4) o GROUP BY g.n),
       typed AS (
         SELECT g.*, o.options,
                CASE g.diff WHEN 'easy' THEN 'single_choice' WHEN 'medium' THEN 'multiple_choice'
                            WHEN 'hard' THEN CASE WHEN g.n % 2 = 0 THEN 'numeric' ELSE 'short_answer' END END AS type
           FROM g JOIN opts o USING (n)),
       v AS (
         INSERT INTO lms.question_versions (id, tenant_id, question_id, version, type, difficulty, presentation, answer_key, created_by)
         SELECT vid, $1, qid, 1, type, diff,
                jsonb_build_object('stem', jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object('type', 'paragraph',
                         'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Question ' || n))))))
                  || CASE WHEN type IN ('single_choice', 'multiple_choice') THEN jsonb_build_object('options', options) ELSE '{}'::jsonb END,
                CASE type
                  WHEN 'single_choice' THEN jsonb_build_object('correct', jsonb_build_array(options -> 0 ->> 'id'))
                  WHEN 'multiple_choice' THEN jsonb_build_object('partial', true, 'correct', jsonb_build_array(options -> 0 ->> 'id', options -> 1 ->> 'id'))
                  WHEN 'numeric' THEN jsonb_build_object('value', n, 'tolerance', 0.5, 'mode', 'absolute')
                  ELSE jsonb_build_object('mode', 'auto', 'accepted', jsonb_build_array('answer ' || n)) END,
                $2
           FROM typed RETURNING 1),
       q AS (
         INSERT INTO lms.questions (id, tenant_id, course_id, current_version_id, created_by)
         SELECT qid, $1, $3, vid, $2 FROM typed RETURNING id)
       INSERT INTO lms.question_tags (tenant_id, course_id, question_id, tag)
       SELECT $1, $3, qid, 'bank' FROM typed`,
      [tenantId, instructorId, courseId],
    );
    for (const id of itemIds) {
      await owner.query(
        `UPDATE lms.assessments SET kind = 'exam', time_limit_minutes = 60, shuffle_questions = true, shuffle_options = true
          WHERE tenant_id = $1 AND item_id = $2`,
        [tenantId, id],
      );
      await owner.query(
        `INSERT INTO lms.assessment_slots (tenant_id, assessment_item_id, position, kind, tag, difficulty, count, points)
         VALUES ($1, $2, 1, 'pool', 'bank', 'easy', 20, 1), ($1, $2, 2, 'pool', 'bank', 'medium', 20, 1),
                ($1, $2, 3, 'pool', 'bank', 'hard', 10, 2)`,
        [tenantId, id],
      );
    }
    await owner.query('COMMIT');
    say(
      `## college: ${LEARNERS} learners, a bank of 300 questions, a ${PER_PAPER}-question paper from 3 random pools, no statistics`,
    );

    // ------------------------------------------------------------------ the app
    const env = parseApiEnv({
      ...process.env,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      RATE_LIMIT_MAX: '10000000',
    });
    db = createDb({
      url: env.DATABASE_APP_URL,
      ssl: env.DB_SSL,
      sslCa: env.DB_SSL_CA,
      max: resolvePoolMax(env),
      applicationName: 'lms-bench-assessments',
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
    const cookie = (n: number) => `sid=${tokens[n % tokens.length]}`;
    const O = `/api/offerings/${offeringId}`;

    const stats = (name: string, r: autocannon.Result, extra = '') => {
      say(
        `   ${name}: ${r['2xx']} ok / ${r.non2xx} non-2xx / ${r.errors} errors in ${round(r.duration, 1)} s = ${Math.round(r.requests.average)} req/s; latency p50 ${r.latency.p50} ms, p97.5 ${r.latency.p97_5} ms, p99 ${r.latency.p99} ms, max ${r.latency.max} ms${extra}`,
      );
      if (r.non2xx > 0 || r.errors > 0) throw new Error(`${name}: requests failed`);
    };

    // ------------------------------------------------------------------ 1. starts, then the resume read
    const attemptsOf = async (item: string) =>
      (
        await owner.query<{ id: string; participant_id: string }>(
          'SELECT id, participant_id FROM lms.attempts WHERE tenant_id = $1 AND assessment_item_id = $2 ORDER BY id',
          [tenantId, item],
        )
      ).rows;
    const startAll = async (item: string, label: string) => {
      let next = 0;
      const t0 = performance.now();
      const r = await autocannon({
        url: base,
        connections: CONNECTIONS,
        amount: LEARNERS,
        headers,
        requests: [
          {
            method: 'POST',
            setupRequest: (req: autocannon.Request) => {
              req.path = `${O}/items/${item}/attempts`;
              req.headers = { ...headers, cookie: cookie(next++) };
              req.body = '{}';
              return req;
            },
          },
        ],
      });
      stats(`${label} (${LEARNERS} learners start the exam)`, r, `; all started in ${secs(t0)} s`);
      const n = (await attemptsOf(item)).length;
      if (n !== LEARNERS) throw new Error(`expected ${LEARNERS} attempts, found ${n}`);
      return r;
    };
    say('## 1. starts (one database call draws, shuffles and stores the paper)');
    const starts = await startAll(itemIds[0] as string, 'POST attempts');
    say(
      `   => ${Math.round(starts.requests.average)} starts/s: ${LEARNERS} learners start in about ${round(LEARNERS / starts.requests.average, 1)} s (the target is 60 s)`,
    );
    // a page load: the learner reads the attempt (questions, saved answers and revisions)
    {
      // the attempt of learner n is not the n-th row: map through the user, so each cookie reads its OWN attempt
      const byUser = (
        await owner.query<{ user_id: string; id: string }>(
          `SELECT tm.user_id, a.id FROM lms.attempts a
             JOIN lms.course_participants p ON p.tenant_id = a.tenant_id AND p.id = a.participant_id
             JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            WHERE a.tenant_id = $1 AND a.assessment_item_id = $2`,
          [tenantId, itemIds[0]],
        )
      ).rows;
      const idOfUser = new Map(byUser.map((r) => [r.user_id, r.id]));
      let next = 0;
      const r = await autocannon({
        url: base,
        connections: CONNECTIONS,
        amount: LEARNERS,
        headers,
        requests: [
          {
            method: 'GET',
            setupRequest: (req: autocannon.Request) => {
              const n = next++;
              req.path = `${O}/attempts/${idOfUser.get(userIds[n % userIds.length] as string)}`;
              req.headers = { ...headers, cookie: cookie(n) };
              return req;
            },
          },
        ],
      });
      stats('GET attempt (resume read, 50 questions)', r);
    }
    const attemptOfLearner = async (item: string) => {
      const rows = (
        await owner.query<{ user_id: string; id: string }>(
          `SELECT tm.user_id, a.id FROM lms.attempts a
             JOIN lms.course_participants p ON p.tenant_id = a.tenant_id AND p.id = a.participant_id
             JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            WHERE a.tenant_id = $1 AND a.assessment_item_id = $2`,
          [tenantId, item],
        )
      ).rows;
      const m = new Map(rows.map((x) => [x.user_id, x.id]));
      return userIds.map((u) => m.get(u) as string);
    };
    const attemptIdsA = await attemptOfLearner(itemIds[0] as string);

    // ------------------------------------------------------------------ 2. autosave
    say(
      '## 2. autosave (PUT answers: one changed answer per request, revisions rising, the whole write path)',
    );
    let saveN = 0;
    const saveLoad = (name: string, seconds: number, rate: number | undefined) => {
      return autocannon({
        url: base,
        connections: CONNECTIONS,
        duration: seconds,
        ...(rate ? { overallRate: rate } : {}),
        headers,
        requests: [
          {
            method: 'PUT',
            setupRequest: (req: autocannon.Request) => {
              const n = saveN++;
              const learner = n % LEARNERS;
              req.path = `${O}/attempts/${attemptIdsA[learner]}/answers`;
              req.headers = { ...headers, cookie: cookie(learner) };
              req.body = JSON.stringify({
                answers: [
                  {
                    position: 1 + ((n * 7) % PER_PAPER),
                    answer: { o: [randomBytes(6).toString('hex')] },
                    rev: 2 + Math.floor(n / LEARNERS),
                    flagged: n % 5 === 0,
                    at: Date.now(),
                    spentMs: 4000,
                  },
                ],
                events: n % 20 === 0 ? [{ kind: 'blur', at: Date.now() }] : [],
              });
              return req;
            },
          },
        ],
      }).then((r) => {
        stats(name, r);
        return r;
      });
    };
    // answers to start from (revision 1) so that every attempt has a full, plausible paper before the saves begin
    const fill = async (item: string) =>
      owner.query(
        `UPDATE lms.attempt_questions aq
            SET answer = CASE v.type WHEN 'numeric' THEN '{"n": 3}'::jsonb WHEN 'short_answer' THEN '{"t": "answer 7"}'::jsonb
                                     ELSE jsonb_build_object('o', jsonb_build_array(aq.option_order[1])) END,
                rev = 1, client_at = 1
           FROM lms.question_versions v
          WHERE aq.tenant_id = $1 AND aq.assessment_item_id = $2 AND v.tenant_id = aq.tenant_id AND v.id = aq.question_version_id`,
        [tenantId, item],
      );
    await fill(itemIds[0] as string);
    const realisticRate = Math.round(LEARNERS / 30);
    const real = await saveLoad(
      `realistic: each learner changes an answer every ~30 s (${realisticRate} saves/s)`,
      REALISTIC_SECONDS,
      realisticRate,
    );
    const worst = await saveLoad(
      `worst case: everybody saves every 3 s (${Math.round(LEARNERS / 3)} saves/s)`,
      WORST_SECONDS,
      Math.round(LEARNERS / 3),
    );
    const sat = await saveLoad(
      'saturation: as fast as this machine goes',
      SATURATION_SECONDS,
      undefined,
    );
    say(
      `   => realistic ${Math.round(real.requests.average)}/s p99 ${real.latency.p99} ms; worst case ${Math.round(worst.requests.average)}/s p99 ${worst.latency.p99} ms; saturation ${Math.round(sat.requests.average)}/s p99 ${sat.latency.p99} ms`,
    );
    const applied = Number(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.attempt_questions WHERE tenant_id = $1 AND assessment_item_id = $2 AND rev > 1',
          [tenantId, itemIds[0]],
        )
      ).rows[0].n,
    );
    say(
      `   (${applied} answers carry a revision above 1: the saves were APPLIED, not answered as stale)`,
    );

    // ------------------------------------------------------------------ 3. the submit burst
    say(
      '## 3. submit burst (every learner hands in at once; the database scores 50 answers per call)',
    );
    {
      let next = 0;
      const t0 = performance.now();
      const r = await autocannon({
        url: base,
        connections: CONNECTIONS,
        amount: LEARNERS,
        headers,
        requests: [
          {
            method: 'POST',
            setupRequest: (req: autocannon.Request) => {
              const n = next++;
              req.path = `${O}/attempts/${attemptIdsA[n]}/submit`;
              req.headers = { ...headers, cookie: cookie(n) };
              req.body = '{}';
              return req;
            },
          },
        ],
      });
      stats(
        `POST submit (${LEARNERS} attempts x ${PER_PAPER} questions)`,
        r,
        `; burst done in ${secs(t0)} s`,
      );
      const graded = Number(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM lms.attempts WHERE tenant_id = $1 AND assessment_item_id = $2 AND status = 'graded'`,
            [tenantId, itemIds[0]],
          )
        ).rows[0].n,
      );
      say(
        `   => ${graded} of ${LEARNERS} attempts scored; the whole class hands in within ${round(LEARNERS / r.requests.average, 1)} s (the target is the last 2 minutes)`,
      );
    }

    // ------------------------------------------------------------------ 4. auto-submit and grading
    say('## 4. auto-submit with the browsers closed, and the grading time of the whole class');
    await startAll(itemIds[1] as string, 'POST attempts (second cohort)');
    await fill(itemIds[1] as string);
    await owner.query(
      `UPDATE lms.attempts SET deadline_at = now() - interval '10 minutes' WHERE tenant_id = $1 AND assessment_item_id = $2`,
      [tenantId, itemIds[1]],
    );
    const sweepService = app.modules.assessments.service;
    const t0 = performance.now();
    const closed = await sweepService.sweep();
    const sweepSeconds = secs(t0);
    say(
      `   sweeper: ${closed} attempts x ${PER_PAPER} questions = ${closed * PER_PAPER} answers closed and scored in ${sweepSeconds} s (batches of 200, one statement each) = ${Math.round(closed / sweepSeconds)} attempts/s`,
    );
    const left = Number(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM lms.attempts WHERE tenant_id = $1 AND assessment_item_id = $2 AND status = 'in_progress'`,
          [tenantId, itemIds[1]],
        )
      ).rows[0].n,
    );
    say(`   attempts still open afterwards: ${left}`);

    // the instructor's reads over the finished class
    const timeIt = async (label: string, fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      say(`   ${label}: ${round(performance.now() - t, 0)} ms`);
    };
    const aSvc = app.modules.assessments.service;
    const ctx = {
      userId: instructorId,
      tenantId,
      role: 'member' as const,
      isPlatformAdmin: false,
      sessionId: newId(),
      email: `teacher@${slug}.test`,
      displayName: 'Bench Teacher',
      ip: null,
      userAgent: null,
    };
    const questionId = (
      await owner.query<{ question_id: string }>(
        'SELECT question_id FROM lms.attempt_questions WHERE tenant_id = $1 AND assessment_item_id = $2 LIMIT 1',
        [tenantId, itemIds[1]],
      )
    ).rows[0]?.question_id;
    const item1 = itemIds[1] as string;
    await timeIt(`regrade (credit one question) over ${LEARNERS} attempts: dry run`, () =>
      aSvc.regrade(ctx, offeringId, item1, {
        questionId: questionId as string,
        action: 'credit',
        dryRun: true,
      }),
    );
    await timeIt(`regrade (credit one question) over ${LEARNERS} attempts: apply`, () =>
      aSvc.regrade(ctx, offeringId, item1, {
        questionId: questionId as string,
        action: 'credit',
        dryRun: false,
      }),
    );
    await timeIt(`item analysis of ${LEARNERS} attempts x ${PER_PAPER} questions`, () =>
      aSvc.analysis(ctx, offeringId, item1),
    );
    await timeIt('final scores of the offering (gradebook interface)', () =>
      aSvc.finalScores(tenantId, offeringId),
    );
    await timeIt('attempts list page (50 rows)', () =>
      aSvc.attempts(ctx, offeringId, item1, { limit: 50 }),
    );
    void out;
  } finally {
    await app?.close().catch(() => undefined);
    await db?.close?.().catch(() => undefined);
    try {
      await owner.query('ROLLBACK').catch(() => undefined); // a failed set-up leaves its transaction open
      await owner.query('BEGIN');
      await deleteTenantCascade(owner, tenantId);
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK').catch(() => undefined);
      console.error(
        `cleanup failed, run: pnpm db:dev:clean --yes --project-ref local (${String(err)})`,
      );
    }
    for (const t of examTables)
      await owner.query(`ALTER TABLE lms.${t} RESET (autovacuum_enabled)`).catch(() => undefined);
    await owner.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
