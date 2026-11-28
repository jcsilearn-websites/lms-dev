import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir as osTmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import autocannon from 'autocannon';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv, parseOwnerEnv, resolvePoolMax } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createCapturingProvider, createUnsubscribeTokens } from '../src/core/mail';
import { createPasswordHasher } from '../src/core/password';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { createEmailRepository, createEmailService } from '../src/modules/email';

// Step 13 benchmark on a SCRATCH database ("lms_bench_s13_<random>", created, migrated and dropped here: the dev database is
// never touched). A 10,000-student college, 200 offerings x 60 learners (12,000 enrolments), an assignment due in an hour in every
// offering, 30 % of the learners already handed in. It measures
//   1. the due-date reminder (1 hour): AUDIENCE SELECTION alone, then the WHOLE scan statement (selection + in-app rows + outbox rows +
//      email.send jobs), in two statistics states: a freshly loaded college without statistics and after ANALYZE (the lesson of
//      steps 8, 11 and 12);
//   2. SEND throughput against a fake provider (claim + render + mark per email) at 1, 4 and 8 concurrent senders;
//   3. the unread-count endpoint under load (HTTP, 200 and 304) and its definer function alone;
//   4. the daily digests (new content per course, work waiting to be graded) for the same college.
//
//   pnpm --filter @lms/backend run bench:notifications     BENCH_STUDENTS=10000 BENCH_OFFERINGS=200 BENCH_PER_OFFERING=60 BENCH_KEEP=1 [BENCH_MIGRATE_UPTO=0064]

const STUDENTS = Number(process.env.BENCH_STUDENTS ?? 10_000);
const OFFERINGS = Number(process.env.BENCH_OFFERINGS ?? 200);
const PER_OFFERING = Number(process.env.BENCH_PER_OFFERING ?? 60);
const SIGNED_IN = 99;
const SECONDS = Number(process.env.BENCH_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 64);

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const swapDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const baseUrl = new URL(ownerEnv.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname))
    throw new Error('the benchmark creates a scratch database: localhost only');
  const dbName = `lms_bench_s13_${randomBytes(3).toString('hex')}`;
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
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    // BENCH_MIGRATE_UPTO=0064: migrate only up to that number (an A/B of one migration, e.g. 0065 = notify_fanout's membership check)
    let migrationsDir = MIGRATIONS_DIR;
    const upto = process.env.BENCH_MIGRATE_UPTO;
    if (upto) {
      migrationsDir = await mkdtemp(joinPath(osTmpdir(), 'bench-migrations-'));
      await cp(MIGRATIONS_DIR, migrationsDir, { recursive: true });
      for (const f of await readdir(migrationsDir))
        if (f.slice(0, 4) > upto) await rm(joinPath(migrationsDir, f));
    }
    await runMigrations({
      ownerUrl,
      ssl: ownerEnv.DB_SSL,
      sslCa: ownerEnv.DB_SSL_CA,
      appPassword: decodeURIComponent(new URL(appUrl).password),
      migrationsDir,
    });
    owner = new pg.Client(connectionConfig(ownerUrl, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA));
    await owner.connect();
    // autovacuum would ANALYZE the freshly loaded tables mid-run and hide the planner problem of a new college (steps 8, 11, 12):
    // off for every table of this scratch database, so "no statistics" stays true until the benchmark itself says ANALYZE
    await owner.query(`DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'lms' LOOP
        EXECUTE format('ALTER TABLE lms.%I SET (autovacuum_enabled = false)', t);
      END LOOP; END $$`);
    const q = (sql: string, p: unknown[] = []) => (owner as pg.Client).query(sql, p);
    const slug = `bench-${randomBytes(3).toString('hex')}`;
    const host = `${slug}.localhost`;
    const tenantId = newId();
    const password = randomBytes(18).toString('hex');
    const hash = await createPasswordHasher({ concurrency: 1 }).hash(password);

    // ------------------------------------------------------------------ the college (triggers off: a set-based load)
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
    await q(`INSERT INTO lms.users (id, email, display_name)
             SELECT lms.uuid_v7(), 't' || g || '@${slug}.test', 'Teacher ' || g FROM generate_series(1, 20) g`);
    await q(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
       SELECT lms.uuid_v7(), $1, u.id, 'member', 'active' FROM lms.users u WHERE u.email LIKE '%@${slug}.test'`,
      [tenantId],
    );
    // the first 99 students can sign in
    await q(
      `INSERT INTO lms.user_credentials (user_id, password_hash)
       SELECT u.id, $1 FROM lms.users u WHERE u.email ~ '^s([1-9]|[1-9][0-9])@${slug}.test$'`,
      [hash],
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
      `CREATE TEMP TABLE bo AS SELECT id, course_id, row_number() OVER (ORDER BY id) AS n FROM lms.course_offerings WHERE tenant_id = '${tenantId}'`,
    );
    await q(`CREATE TEMP TABLE bm AS SELECT m.id AS mid, m.user_id, u.email, row_number() OVER (ORDER BY m.id) AS n
               FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
              WHERE m.tenant_id = '${tenantId}' AND u.email LIKE 's%@${slug}.test'`);
    await q(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source, created_at)
       SELECT lms.uuid_v7(), $1, bo.id, bm.mid, 'learner', 'manual', '2026-06-01'
         FROM bo CROSS JOIN generate_series(0, ${PER_OFFERING - 1}) k
         JOIN bm ON bm.n = ((bo.n * 50 + k) % ${STUDENTS}) + 1`,
      [tenantId],
    );
    // 20 teachers: teacher t teaches offerings n with n % 20 = t - 1
    await q(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
       SELECT lms.uuid_v7(), $1, bo.id, m.id, 'instructor', 'manual'
         FROM bo JOIN lms.users u ON u.email = 't' || ((bo.n % 20) + 1) || '@${slug}.test'
         JOIN lms.tenant_memberships m ON m.tenant_id = $1 AND m.user_id = u.id`,
      [tenantId],
    );
    // one module per offering, 5 text items + 1 assignment (due in 1 hour + 5 s: the 1-hour threshold is 5 s from now)
    await q(
      `INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published)
       SELECT lms.uuid_v7(), $1, bo.id, 'Module', 'm1x', true FROM bo`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, published, required, completion)
       SELECT lms.uuid_v7(), $1, m.offering_id, m.id, 'text', 'Reading ' || i, 'i' || i || 'x', '{"type":"doc"}'::jsonb, true, false, 'manual'
         FROM lms.content_modules m, generate_series(1, 5) i WHERE m.tenant_id = $1`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, published, required, completion)
       SELECT lms.uuid_v7(), $1, m.offering_id, m.id, 'assignment', 'Essay', 'a1x', true, true, 'on_submit'
         FROM lms.content_modules m WHERE m.tenant_id = $1`,
      [tenantId],
    );
    const due = new Date(Date.now() + 3_600_000 + 5000);
    await q(
      `INSERT INTO lms.assignments (tenant_id, item_id, offering_id, course_id, due_at, release_mode)
       SELECT $1, i.id, i.offering_id, o.course_id, $2::timestamptz, 'manual'
         FROM lms.content_items i JOIN lms.course_offerings o ON o.tenant_id = i.tenant_id AND o.id = i.offering_id
        WHERE i.tenant_id = $1 AND i.kind = 'assignment'`,
      [tenantId, due.toISOString()],
    );
    await q(`CREATE TEMP TABLE bl AS SELECT p.id AS pid, p.offering_id AS oid
               FROM lms.course_participants p WHERE p.tenant_id = '${tenantId}' AND p.participation = 'learner'`);
    // 30 % of the (learner, assignment) pairs already handed in
    await q(
      `INSERT INTO lms.submissions (id, tenant_id, assignment_item_id, offering_id, participant_id, version_no, text_body, request_key, submitted_at)
       SELECT lms.uuid_v7(), $1, i.id, bl.oid, bl.pid, 1, 'x', lms.uuid_v7(), now() - interval '1 day'
         FROM bl JOIN lms.content_items i ON i.tenant_id = $1 AND i.offering_id = bl.oid AND i.kind = 'assignment'
        WHERE abs(hashtext(bl.pid::text)) % 10 < 3`,
      [tenantId],
    );
    await q(
      `INSERT INTO lms.tenant_settings (id, tenant_id, key, value) VALUES (lms.uuid_v7(), $1, 'notifications', '{"quietHours":{"enabled":false,"start":"22:00","end":"07:00"}}')`,
      [tenantId],
    );
    await q('COMMIT');
    const enrolments = Number(
      (
        await q(
          `SELECT count(*)::int n FROM lms.course_participants WHERE tenant_id = $1 AND participation = 'learner'`,
          [tenantId],
        )
      ).rows[0].n,
    );
    const handedIn = Number(
      (await q(`SELECT count(*)::int n FROM lms.submissions WHERE tenant_id = $1`, [tenantId]))
        .rows[0].n,
    );
    say(
      `## college: ${STUDENTS} students, ${OFFERINGS} offerings x ${PER_OFFERING} learners = ${enrolments} enrolments, ${handedIn} already handed in (loaded in ${ms(g0)} ms)`,
    );
    const expected = enrolments - handedIn;
    const nowForScan = new Date(due.getTime() - 58 * 60_000); // the 1-hour threshold was 2 minutes before this instant

    // the audience of the 1-hour reminder alone: a copy of the win / cand part of lms.notify_scan_tenant (selection, no writes)
    const selectionSql = `
      WITH win AS MATERIALIZED (
        SELECT a.item_id, a.offering_id, a.due_at AS due,
               CASE WHEN a.due_at - interval '1 hour' > $2::timestamptz - interval '5 minutes'
                         AND a.due_at - interval '1 hour' <= $2::timestamptz AND $2::timestamptz < a.due_at THEN 1 END AS hours
          FROM lms.assignments a
          JOIN lms.content_items i ON i.tenant_id = $1 AND i.id = a.item_id AND i.published AND i.deleted_at IS NULL
          JOIN lms.content_modules md ON md.tenant_id = $1 AND md.id = i.module_id AND md.published AND md.deleted_at IS NULL
          JOIN lms.course_offerings o ON o.tenant_id = $1 AND o.id = a.offering_id AND o.status = 'published'
         WHERE a.tenant_id = $1 AND a.due_at > $2::timestamptz - interval '5 minutes' + interval '1 hour'
           AND a.due_at <= $2::timestamptz + interval '24 hours'),
      cand AS MATERIALIZED (
        SELECT w.item_id, p.id AS participant_id, p.membership_id
          FROM win w
          CROSS JOIN LATERAL (SELECT pp.id, pp.membership_id FROM lms.course_participants pp
                               WHERE pp.tenant_id = $1 AND pp.offering_id = w.offering_id
                                 AND pp.participation = 'learner' AND pp.status = 'active' OFFSET 0) p
         WHERE w.hours IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM lms.assignment_extensions e WHERE e.tenant_id = $1
                             AND e.assignment_item_id = w.item_id AND e.participant_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM lms.submissions s WHERE s.tenant_id = $1 AND s.assignment_item_id = w.item_id
                             AND s.participant_id = p.id))
      SELECT count(*)::int AS n FROM cand c
        CROSS JOIN LATERAL (SELECT 1 FROM lms.tenant_memberships mm WHERE mm.tenant_id = $1 AND mm.id = c.membership_id
                               AND mm.status = 'active' OFFSET 0) m`;

    async function reset() {
      await q(
        `TRUNCATE lms.notifications, lms.email_outbox, lms.notify_scan_state, lms.notify_runs, lms.notify_content_marks`,
      );
      await q(`DELETE FROM lms.jobs WHERE queue = 'email.send'`);
    }
    async function reminderRun(label: string) {
      const sel: number[] = [];
      let audience = 0;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        audience = Number((await q(selectionSql, [tenantId, nowForScan.toISOString()])).rows[0].n);
        sel.push(performance.now() - t0);
      }
      const t1 = performance.now();
      const res = (
        await q('SELECT lms.notify_scan_tenant($1, $2) AS r', [tenantId, nowForScan.toISOString()])
      ).rows[0].r as Record<string, number>;
      const whole = ms(t1);
      const rows = {
        notifications: Number(
          (await q("SELECT count(*)::int n FROM lms.notifications WHERE type = 'due_soon'")).rows[0]
            .n,
        ),
        outbox: Number(
          (await q("SELECT count(*)::int n FROM lms.email_outbox WHERE status = 'queued'")).rows[0]
            .n,
        ),
        jobs: Number(
          (await q("SELECT count(*)::int n FROM lms.jobs WHERE queue = 'email.send'")).rows[0].n,
        ),
      };
      say(
        `## 1. due-date reminder (${label}): audience ${audience} (expected ${expected}: handed-in learners excluded)\n` +
          `   audience selection alone (median of 3): ${Math.round(median(sel) * 10) / 10} ms\n` +
          `   WHOLE scan statement (selection + ${rows.notifications} in-app rows + ${rows.outbox} outbox rows + ${rows.jobs} jobs, ONE statement): ${whole} ms\n` +
          `   => enqueue ~ ${Math.round((whole - median(sel)) * 10) / 10} ms (${Math.round((rows.notifications / whole) * 1000)} notifications/s); scan result ${JSON.stringify(res)}`,
      );
      if (audience !== expected || rows.notifications !== expected)
        throw new Error(
          `audience wrong: ${audience} / ${rows.notifications} (expected ${expected})`,
        );
      // what EVERY college pays at EVERY tick (every NOTIFY_SCAN_SECONDS) when nothing is due: the same statement, a quiet minute
      const quiet = new Date(nowForScan.getTime() + 10 * 60_000);
      const idle: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await q('SELECT lms.notify_scan_tenant($1, $2)', [
          tenantId,
          new Date(quiet.getTime() + i * 60_000).toISOString(),
        ]);
        idle.push(performance.now() - t);
      }
      say(
        `   IDLE scan (nothing due: the statement every college runs at every tick), median of 5: ${Math.round(median(idle) * 10) / 10} ms`,
      );
      return rows;
    }

    // ------------------------------------------------------------------ 1. reminders: fresh (no statistics), then analyzed
    await reminderRun('freshly loaded college, NO statistics');
    await reset();
    await q('ANALYZE');
    await reminderRun('after ANALYZE');
    await reset();
    await reminderRun(
      'freshly loaded again: the scan is idempotent, the data and the plan are those of the analyzed state',
    );

    // ------------------------------------------------------------------ 2. send throughput against a fake provider
    const env = parseApiEnv({
      // benchmarks sign in with a password alone
      MFA_ENFORCEMENT: 'off',
      ...process.env,
      DATABASE_APP_URL: appUrl,
      EMAIL_PROVIDER: 'none',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_FAILURES_PER_IP: '100000',
      RATE_LIMIT_AUTH_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      RATE_LIMIT_MAX: '10000000',
    });
    db = createDb({
      url: env.DATABASE_APP_URL,
      ssl: env.DB_SSL,
      sslCa: env.DB_SSL_CA,
      max: Math.max(resolvePoolMax(env), 10),
      applicationName: 'lms-bench-notifications',
    });
    const provider = createCapturingProvider();
    const mailer = createEmailService({
      db,
      emailRepo: createEmailRepository(),
      provider,
      rate: { take: async () => {} },
      unsubscribe: createUnsubscribeTokens('b'.repeat(64), { ttlSeconds: 3600 }),
      webhooks: [],
      tokens: {
        invite: async () => null,
        reset: async () => ({ token: 't', minutes: 30 }),
        mfaEnrol: async () => ({ token: 't', minutes: 30 }),
      },
      config: {
        baseDomain: 'localhost',
        secure: false,
        publicPort: undefined,
        fromDefault: 'no-reply@notify.localhost',
        fromName: 'JCS iLearn',
        unsubscribeTtlSeconds: 3600,
        outboxRetentionDays: 30,
        purgeBatchSize: 1000,
      },
    });
    const ids = (
      await q("SELECT id FROM lms.email_outbox WHERE status = 'queued' ORDER BY id")
    ).rows.map((r) => r.id as string);
    const SLICE = Math.min(1500, Math.floor(ids.length / 3));
    let offset = 0;
    for (const conc of [1, 4, 8]) {
      const mine = ids.slice(offset, offset + SLICE);
      offset += SLICE;
      let next = 0;
      const lat: number[] = [];
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: conc }, async () => {
          for (;;) {
            const id = mine[next++];
            if (!id) return;
            const s = performance.now();
            await mailer.deliver(id, { attempt: 1, maxAttempts: 5 });
            lat.push(performance.now() - s);
          }
        }),
      );
      const total = ms(t0);
      say(
        `## 2. send throughput, fake provider, ${conc} concurrent sender(s): ${mine.length} emails in ${total} ms = ${Math.round((mine.length / total) * 1000)} emails/s ` +
          `(p50 ${Math.round(median(lat) * 10) / 10} ms, p99 ${Math.round((lat.sort((a, b) => a - b)[Math.floor(lat.length * 0.99)] ?? 0) * 10) / 10} ms; 2 statements per email: claim + mark)`,
      );
    }
    say(
      `   the fake provider received ${provider.sent.length} emails; the real limit is the provider's rate (EMAIL_RATE_PER_SECOND per worker)`,
    );

    // ------------------------------------------------------------------ 3. the unread count under load
    await q(
      `INSERT INTO lms.notifications (id, tenant_id, user_id, category, type, params, dedupe_key)
       SELECT lms.uuid_v7(), $1, u.id, 'learning_content', 'content_digest', '{}', 'bench:' || g
         FROM lms.users u CROSS JOIN generate_series(1, 30) g
        WHERE u.email ~ '^s([1-9]|[1-9][0-9])@${slug}.test$'`,
      [tenantId],
    );
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
    const cookies: string[] = [];
    for (let i = 1; i <= SIGNED_IN; i++) cookies.push(await login(`s${i}@${slug}.test`));
    // every member's own ETag (it depends on their newest unread notification)
    const etagOf = (cookie: string) =>
      new Promise<string>((resolve, reject) => {
        const req = request(
          `${base}/api/notifications/unread-count`,
          { headers: { ...headers, cookie } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(String(res.headers.etag)));
          },
        );
        req.on('error', reject);
        req.end();
      });
    const etags: string[] = [];
    for (const c of cookies) etags.push(await etagOf(c));
    for (const [label, withEtag] of [
      ['200 (the count changed)', false],
      ['304 (nothing changed: ETag sent)', true],
    ] as const) {
      let n = 0;
      const result = await autocannon({
        url: base,
        connections: CONNECTIONS,
        duration: SECONDS,
        headers,
        requests: [
          {
            method: 'GET',
            path: '/api/notifications/unread-count',
            setupRequest: (req: autocannon.Request, ctx: object) => {
              const context = ctx as Record<string, unknown>;
              if (context.cookie === undefined) {
                const k = n++ % cookies.length;
                context.cookie = cookies[k];
                context.etag = etags[k];
              }
              req.headers = {
                ...headers,
                cookie: context.cookie as string,
                ...(withEtag ? { 'if-none-match': context.etag as string } : {}),
              };
              return req;
            },
          },
        ],
      });
      say(
        `## 3. GET /notifications/unread-count, ${label}: ${cookies.length} members, ${CONNECTIONS} connections, ${SECONDS} s\n` +
          `   ${Math.round(result.requests.average)} req/s (mean), p50 ${result.latency.p50} ms, p99 ${result.latency.p99} ms, non-2xx ${result.non2xx}, errors ${result.errors}, timeouts ${result.timeouts}`,
      );
    }
    {
      const pool = new pg.Pool({
        ...connectionConfig(appUrl, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
        max: 8,
      });
      const users = (
        await q(`SELECT id FROM lms.users WHERE email ~ '^s([1-9]|[1-9][0-9])@${slug}.test$'`)
      ).rows.map((r) => r.id as string);
      let calls = 0;
      const lat: number[] = [];
      const end = Date.now() + 5000;
      await Promise.all(
        Array.from({ length: 8 }, async (_, w) => {
          while (Date.now() < end) {
            const s = performance.now();
            await pool.query('SELECT * FROM lms.notify_unread($1, $2)', [
              tenantId,
              users[(calls + w) % users.length],
            ]);
            lat.push(performance.now() - s);
            calls++;
          }
        }),
      );
      await pool.end();
      say(
        `   the definer function alone (no HTTP), 8 connections: ${Math.round(calls / 5)} calls/s, p50 ${Math.round(median(lat) * 100) / 100} ms, p99 ${Math.round((lat.sort((a, b) => a - b)[Math.floor(lat.length * 0.99)] ?? 0) * 100) / 100} ms`,
      );
    }

    // ------------------------------------------------------------------ 4. the daily digests
    await reset();
    await q(
      `INSERT INTO lms.notify_content_marks (tenant_id, item_id, offering_id, visible_at)
       SELECT $1, i.id, i.offering_id, now() - interval '1 hour' FROM lms.content_items i WHERE i.tenant_id = $1 AND i.kind = 'text'`,
      [tenantId],
    );
    const { rows: at } = await q(
      `SELECT ((((now() AT TIME ZONE 'Asia/Kolkata')::date + 1) + time '08:00') AT TIME ZONE 'Asia/Kolkata') AS at`,
    );
    const digestNow = new Date(at[0].at);
    const t4 = performance.now();
    const res = (
      await q('SELECT lms.notify_scan_tenant($1, $2) AS r', [tenantId, digestNow.toISOString()])
    ).rows[0].r as Record<string, number>;
    const digestMs = ms(t4);
    say(
      `## 4. daily digests at the digest hour: ONE statement ${digestMs} ms: ${JSON.stringify(res)} ` +
        `(content: ${OFFERINGS * 5} new items -> one digest per course per learner; grading: waiting hand-ins -> one per instructor)`,
    );
    const total = Number((await q('SELECT count(*)::int n FROM lms.notifications')).rows[0].n);
    say(
      `   ${total} notifications and ${Number((await q('SELECT count(*)::int n FROM lms.email_outbox')).rows[0].n)} outbox rows written`,
    );
  } finally {
    if (app) await app.close().catch(() => {});
    if (db) await db.close().catch(() => {});
    if (owner) await owner.end().catch(() => {});
    if (process.env.BENCH_KEEP) {
      console.log(`kept the scratch database ${dbName}`);
    } else {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    }
    await admin.end().catch(() => {});
  }
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  writeFileSync(join(tmpdir(), 'notifications-bench.txt'), out.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
