import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import autocannon from 'autocannon';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv, parseOwnerEnv, resolvePoolMax } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createPasswordHasher } from '../src/core/password';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { deleteTenantCascade } from '../src/db/dev-cleanup';
import { classPageStatement } from '../src/modules/progress/progress.repository';
import { decodeCursor } from '../src/modules/progress/progress.service';

// Step 8 benchmarks against the DEV database, with a throwaway tenant ("bench-<random>") that is deleted in a
// `finally` block (see docs/benchmarks.md, "Step 8"):
//   1. HEARTBEATS over HTTP: POST .../progress/heartbeat from many learners at once (every request is a NEW heartbeat
//      with a new number and a new second, so the whole statement runs: nothing is answered as a duplicate).
//   2. The CLASS VIEW of 500 learners x 100 items: the service call (the DB time: one transaction, one statement) for
//      a page of 100 learners, the filters and the sorts.
//   3. AGGREGATION vs COUNTERS for the percentages: the class page computed from the progress rows (what the product
//      does) against the same page read from per-learner counters kept by a trigger (a scratch schema), and what the
//      counters cost on every write.
//
//   pnpm --filter @lms/backend run bench:progress        HEARTBEAT_SECONDS=10 HEARTBEAT_CONNECTIONS=64

const LEARNERS = 500;
const MODULES = 10;
const PER_MODULE = 10; // 100 items: 8 text + 1 link + 1 video per module
const SIGNED_IN = Number(process.env.HEARTBEAT_LEARNERS ?? 100); // learners with a session (login hashes a password)
const SECONDS = Number(process.env.HEARTBEAT_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.HEARTBEAT_CONNECTIONS ?? 64);

/** where the EXPLAIN plans go: the temp directory, never the repository */
const planFile = (name: string) => path.join(os.tmpdir(), name);
const ms = (t0: number) => Math.round((performance.now() - t0) * 100) / 100;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
async function time<T>(runs: number, fn: () => Promise<T>) {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  return { median: Math.round(median(t) * 100) / 100, p95: Math.round(p95(t) * 100) / 100 };
}

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
  const password = randomBytes(18).toString('hex');
  const tenantId = newId();
  const hash = await createPasswordHasher({ concurrency: 1 }).hash(password);
  const out: string[] = [];
  const say = (s: string) => {
    out.push(s);
    console.log(s);
  };

  let app: ReturnType<typeof buildApp> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
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
    await owner.query(
      `INSERT INTO lms.user_credentials (user_id, password_hash)
       SELECT u.id, $1 FROM lms.users u WHERE u.email ~ '^l([1-9]|[1-9][0-9])@${slug}.test$'`,
      [hash],
    ); // the first 99 learners can sign in
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
    // content: 10 modules x 10 items; the video assets are 1 hour long
    const videoId = newId();
    await owner.query(
      `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status,
                                     duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
       VALUES ($1, $2, $3, $4, 'b.mp4', 1000, 'ready', 3600000, 'x', now(), 1000, 100, '[]'::jsonb)`,
      [videoId, tenantId, offeringId, instructorId],
    );
    await owner.query(
      `WITH mods AS (
         INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published)
         SELECT lms.uuid_v7(), $1, $2, 'Module ' || g, 'm' || to_char(g, 'FM0000') || 'x', true
           FROM generate_series(1, ${MODULES}) g RETURNING id, title)
       INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, url, video_asset_id,
                                      published, required, completion)
       SELECT lms.uuid_v7(), $1, $2, m.id,
              CASE WHEN i = ${PER_MODULE} THEN 'video' WHEN i = ${PER_MODULE - 1} THEN 'link' ELSE 'text' END,
              'Item ' || i, 'i' || to_char(i, 'FM0000') || 'x',
              CASE WHEN i = ${PER_MODULE} OR i = ${PER_MODULE - 1} THEN NULL ELSE '{"type":"doc"}'::jsonb END,
              CASE WHEN i = ${PER_MODULE - 1} THEN 'https://example.org' END,
              CASE WHEN i = ${PER_MODULE} THEN $3::uuid END,
              true, true,
              CASE WHEN i = ${PER_MODULE} THEN 'watch' WHEN i = ${PER_MODULE - 1} THEN 'on_view' ELSE 'manual' END
         FROM mods m, generate_series(1, ${PER_MODULE}) i`,
      [tenantId, offeringId, videoId],
    );
    // 60 % of the (learner, item) pairs have a row, half of those are completed: ~30,000 rows
    await owner.query(
      `INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how,
                                      last_activity_at)
       SELECT $1, p.id, i.id, $2,
              CASE WHEN h % 2 = 0 THEN 'completed' ELSE 'in_progress' END,
              CASE WHEN h % 2 = 0 THEN now() - (h % 20 || ' days')::interval END,
              CASE WHEN h % 2 = 0 THEN 'manual' END,
              now() - (h % 30 || ' days')::interval
         FROM lms.course_participants p
         CROSS JOIN lms.content_items i
         CROSS JOIN LATERAL (SELECT abs(hashtext(p.id::text || i.id::text)) % 10 AS h) x(h)
        WHERE p.tenant_id = $1 AND p.participation = 'learner' AND i.tenant_id = $1 AND i.kind = 'text'
          AND h < 6`,
      [tenantId, offeringId],
    );
    await owner.query('COMMIT');
    await owner.query('ANALYZE lms.item_progress');
    const rows = Number(
      (
        await owner.query('SELECT count(*)::int AS n FROM lms.item_progress WHERE tenant_id = $1', [
          tenantId,
        ])
      ).rows[0].n,
    );
    say(`## college: ${LEARNERS} learners x ${MODULES * PER_MODULE} items, ${rows} progress rows`);

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
      applicationName: 'lms-bench-progress',
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

    if (process.env.CLASS_PROFILE) {
      // CLASS_PROFILE=1: EXPLAIN (ANALYZE, BUFFERS) of the class page statement (the tenant is new and has no statistics,
      // like a college whose progress was just loaded); the plan goes to <tmpdir>/progress-plan.txt
      const { sql } = await import('drizzle-orm');
      const a = {
        tenantId,
        userId: instructorId,
        offeringId,
        viewAll: false,
        accountAllowed: false,
        allowedBy: ['instructor', 'assistant'],
      } as never;
      const base100 = { limit: 100, after: null, section: null, status: null, removed: false };
      const stop = new Error('rollback');
      await db
        .withTenant(tenantId, async (tx) => {
          const plan = await tx.execute(
            sql`EXPLAIN (ANALYZE, BUFFERS) ${classPageStatement(a, { ...base100, sort: 'name', dir: 'asc' } as never)}`,
          );
          const { writeFileSync } = await import('node:fs');
          writeFileSync(
            planFile('progress-plan.txt'),
            plan.rows.map((r) => String(r['QUERY PLAN'])).join('\n'),
          );
          throw stop;
        })
        .catch((e) => {
          if (e !== stop) throw e;
        });
    }

    if (process.env.HB_EXPLAIN) {
      // HB_EXPLAIN=1: the plan of the rule every heartbeat starts with (lms.learner_item_access), in a college
      // without statistics; written to <tmpdir>/progress-plan-access.txt
      const one = (
        await owner.query<{ user_id: string; item: string }>(
          `SELECT tm.user_id, (SELECT id FROM lms.content_items WHERE tenant_id = $1 AND kind = 'video' LIMIT 1) AS item
             FROM lms.course_participants p JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            WHERE p.tenant_id = $1 AND p.participation = 'learner' LIMIT 1`,
          [tenantId],
        )
      ).rows[0];
      const { writeFileSync } = await import('node:fs');
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        const plan = await owner.query(
          'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM lms.learner_item_access($1::uuid, $2::uuid, $3::uuid, $4::uuid)',
          [tenantId, one?.user_id, offeringId, one?.item],
        );
        lines.push(`--- run ${i}`, ...plan.rows.map((r) => String(r['QUERY PLAN'])));
      }
      // the body of the rule itself (the function is not inlined, so its plan is hidden above)
      for (let i = 0; i < 2; i++) {
        const plan = await owner.query(
          `EXPLAIN (ANALYZE, BUFFERS)
           SELECT p.id, i.offering_id, i.kind, i.completion, i.video_asset_id, va.duration_ms, o.completion_threshold
             FROM lms.content_items i
             JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
             JOIN lms.course_offerings o ON o.tenant_id = i.tenant_id AND o.id = i.offering_id
             JOIN lms.course_participants p ON p.tenant_id = i.tenant_id AND p.offering_id = i.offering_id
                                           AND p.participation = 'learner' AND p.status = 'active'
             JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
                                           AND tm.user_id = $2::uuid AND tm.status = 'active'
             LEFT JOIN lms.video_assets va ON va.tenant_id = i.tenant_id AND va.id = i.video_asset_id AND va.status = 'ready'
            WHERE i.tenant_id = $1::uuid AND i.offering_id = $3::uuid AND i.id = $4::uuid
              AND i.deleted_at IS NULL AND m.deleted_at IS NULL
              AND i.published AND m.published AND o.status = 'published'
              AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= now()`,
          [tenantId, one?.user_id, offeringId, one?.item],
        );
        lines.push(`--- body ${i}`, ...plan.rows.map((r) => String(r['QUERY PLAN'])));
      }
      writeFileSync(planFile('progress-plan-access.txt'), lines.join(String.fromCharCode(10)));
    }
    // ------------------------------------------------------------------ 1. heartbeats
    const cookies: string[] = [];
    for (let i = 1; i <= Math.min(SIGNED_IN, 99); i++)
      cookies.push(await login(`l${i}@${slug}.test`));
    const videoItems = (
      await owner.query<{ id: string }>(
        "SELECT id FROM lms.content_items WHERE tenant_id = $1 AND kind = 'video' ORDER BY id",
        [tenantId],
      )
    ).rows.map((r) => r.id);
    let nextClient = 0;
    const result = await autocannon({
      url: base,
      connections: CONNECTIONS,
      duration: SECONDS,
      headers,
      requests: [
        {
          method: 'POST',
          setupRequest: (req: autocannon.Request, ctx: object) => {
            const context = ctx as Record<string, unknown>;
            if (context.seq === undefined) {
              const n = nextClient++;
              context.n = n;
              context.cookie = cookies[n % cookies.length];
              context.stream = newId();
              context.seq = 0;
              context.pos = 0;
              // each learner gets one video item to watch (several connections of one learner share nothing but the bucket)
              context.item = videoItems[n % videoItems.length];
            }
            const seq = (context.seq as number) + 1;
            context.seq = seq;
            const pos = ((context.pos as number) + 1) % 3500;
            context.pos = pos;
            req.path = `/api/offerings/${offeringId}/items/${context.item}/progress/heartbeat`;
            req.headers = { ...headers, cookie: context.cookie as string };
            req.body = JSON.stringify({
              videoId,
              streamId: context.stream,
              seq,
              ranges: [[pos, pos + 1]],
              position: pos + 1,
              rate: 1,
            });
            return req;
          },
        },
      ],
    });
    if (process.env.HEARTBEAT_BASELINE !== '0') {
      // the ceiling of this machine for a request that only pays the session lookup (1 statement): what a heartbeat
      // costs on top of it is the difference
      let k = 0;
      const base1 = await autocannon({
        url: `${base}/api/auth/me`,
        connections: CONNECTIONS,
        duration: Math.max(3, Math.floor(SECONDS / 2)),
        headers,
        requests: [
          {
            method: 'GET',
            setupRequest: (req: autocannon.Request, ctx: object) => {
              const context = ctx as Record<string, unknown>;
              context.cookie ??= cookies[k++ % cookies.length];
              req.headers = { ...headers, cookie: context.cookie as string };
              return req;
            },
          },
        ],
      });
      say(
        `   baseline GET /auth/me (session lookup only): ${Math.round(base1.requests.average)} req/s, p50 ${base1.latency.p50} ms, p99 ${base1.latency.p99} ms`,
      );
    }
    {
      // the DATABASE's capacity: the heartbeat function alone, no HTTP, 8 connections of the application role
      const learners = (
        await owner.query<{ user_id: string }>(
          `SELECT tm.user_id FROM lms.course_participants p JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            WHERE p.tenant_id = $1 AND p.participation = 'learner' ORDER BY tm.id LIMIT 99`,
          [tenantId],
        )
      ).rows.map((r) => r.user_id);
      const pool = new pg.Pool({
        ...connectionConfig(env.DATABASE_APP_URL, env.DB_SSL, env.DB_SSL_CA),
        max: 8,
      });
      const lat: number[] = [];
      const until = Date.now() + SECONDS * 1000;
      let calls = 0;
      await Promise.all(
        Array.from({ length: 8 }, async (_, w) => {
          const stream = newId();
          let seq = 0;
          let pos = 0;
          while (Date.now() < until) {
            seq++;
            pos = (pos + 1) % 3500;
            const t0 = performance.now();
            await pool.query(
              'SELECT * FROM lms.progress_heartbeat($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::int,$8::text,$9::int,$10::numeric)',
              [
                tenantId,
                learners[(w * 11 + (seq % 11)) % learners.length],
                offeringId,
                videoItems[w % videoItems.length],
                videoId,
                stream,
                seq,
                `{[${pos},${pos + 1})}`,
                pos + 1,
                1,
              ],
            );
            lat.push(performance.now() - t0);
            calls++;
          }
        }),
      );
      await pool.end();
      say(
        `   the heartbeat function alone (no HTTP), 8 connections: ${Math.round(calls / SECONDS)} calls/s, ` +
          `p50 ${Math.round(median(lat) * 100) / 100} ms, p99 ${Math.round((lat.sort((a, b) => a - b)[Math.floor(lat.length * 0.99)] ?? 0) * 100) / 100} ms`,
      );
    }
    // the integrity budget cuts what a learner could not have watched in that time: it still runs the whole statement
    const claimed = Number(
      (
        await owner.query(
          'SELECT coalesce(sum(suspicious), 0)::int AS n FROM lms.item_progress WHERE tenant_id = $1',
          [tenantId],
        )
      ).rows[0].n,
    );
    say(
      `## 1. heartbeats over HTTP: ${cookies.length} learners, ${CONNECTIONS} connections, ${SECONDS} s\n` +
        `   ${Math.round(result.requests.average)} req/s (mean), p50 ${result.latency.p50} ms, p99 ${result.latency.p99} ms, ` +
        `non-2xx ${result.non2xx}, errors ${result.errors}, timeouts ${result.timeouts}; ` +
        `flagged (clamped) heartbeats in the table (the function-only run above included): ${claimed}`,
    );

    if (process.env.ANALYZE_ALL) {
      // a college that has been in use for a while: autovacuum has gathered statistics (the default run is the
      // worst case, a college whose rows were just loaded and have none)
      for (const t of [
        'content_items',
        'content_modules',
        'course_participants',
        'tenant_memberships',
        'users',
        'item_progress',
      ])
        await owner.query(`ANALYZE lms.${t}`);
      say('   (statistics gathered: ANALYZE_ALL=1)');
    }
    // ------------------------------------------------------------------ 2. the class view (DB time)
    const service = app.modules.progress.service;
    const ctx = {
      userId: instructorId,
      tenantId,
      role: 'member',
      isPlatformAdmin: false,
      sessionId: 'bench',
      email: `teacher@${slug}.test`,
      displayName: 'Bench Teacher',
      ip: null,
      userAgent: null,
    } as never;
    const base100 = { limit: 100, after: null, section: null, status: null, removed: false };
    const view = (over: Record<string, unknown>) =>
      service.classPage(ctx, offeringId, {
        ...base100,
        sort: 'name',
        dir: 'asc',
        ...over,
      } as never);
    await view({}); // warm
    const first = await view({});
    say(
      `## 2. class view, ${LEARNERS} learners x ${MODULES * PER_MODULE} items (service call = one transaction, one statement)`,
    );
    for (const [label, over] of [
      ['page of 100, by name', {}],
      ['page of 100, by progress', { sort: 'percent', dir: 'desc' }],
      ['page of 100, by last activity', { sort: 'activity', dir: 'desc' }],
      ['status = behind', { status: 'behind' }],
      ['status = completed', { status: 'completed' }],
      ['status = not_started', { status: 'not_started' }],
    ] as const) {
      const t = await time(30, () => view(over));
      say(`   ${label}: median ${t.median} ms, p95 ${t.p95} ms (wall time of the call)`);
      if (t.median > 300) {
        // a slow batch: look at the plan the database uses right now
        const { sql } = await import('drizzle-orm');
        const { writeFileSync } = await import('node:fs');
        const a = {
          tenantId,
          userId: instructorId,
          offeringId,
          viewAll: false,
          accountAllowed: false,
          allowedBy: ['instructor', 'assistant'],
        } as never;
        const stop = new Error('rollback');
        await db
          .withTenant(tenantId, async (tx) => {
            const plan = await tx.execute(
              sql`EXPLAIN (ANALYZE, BUFFERS) ${classPageStatement(a, { ...base100, sort: 'name', dir: 'asc', ...over } as never)}`,
            );
            writeFileSync(
              planFile('progress-plan-slow.txt'),
              plan.rows.map((r) => String(r['QUERY PLAN'])).join(String.fromCharCode(10)),
            );
            throw stop;
          })
          .catch((e) => {
            if (e !== stop) throw e;
          });
        say('   (slow: plan saved in <tmpdir>/progress-plan-slow.txt)');
      }
    }
    // the second page (keyset), then the one learner drilldown
    const second = await view({ after: decodeCursor(first.nextCursor ?? undefined) });
    const t2 = await time(30, () => view({ after: decodeCursor(first.nextCursor ?? undefined) }));
    say(
      `   second page of 100 (keyset): median ${t2.median} ms, p95 ${t2.p95} ms (${second.items.length} rows)`,
    );
    const pid = (first.items[0] as { participantId: string }).participantId;
    const td = await time(30, () => service.learner(ctx, offeringId, pid));
    say(`   one learner, item by item: median ${td.median} ms, p95 ${td.p95} ms`);

    // the statement alone, as the database ran it (no round trips of the transaction)
    const probe = await db.withTenant(tenantId, async (tx) => {
      const { sql } = await import('drizzle-orm');
      const { createProgressRepository } = await import('../src/modules/progress');
      const repo = createProgressRepository();
      const a = {
        tenantId,
        userId: instructorId,
        offeringId,
        viewAll: false,
        accountAllowed: false,
        allowedBy: ['instructor', 'assistant'],
      } as never;
      const t0 = performance.now();
      await repo.classPage(tx, a, { ...base100, sort: 'name', dir: 'asc' } as never);
      const single = ms(t0);
      await tx.execute(sql`SELECT 1`);
      return single;
    });
    say(`   one cold-cache statement inside a transaction: ${probe} ms`);

    if (process.env.CLASS_HUNT) {
      // CLASS_HUNT=1: run the statement over and over, keep the plan of the slowest run (a plan that flips with the
      // statistics shows up as an outlier)
      const { sql } = await import('drizzle-orm');
      const { writeFileSync } = await import('node:fs');
      const a = {
        tenantId,
        userId: instructorId,
        offeringId,
        viewAll: false,
        accountAllowed: false,
        allowedBy: ['instructor', 'assistant'],
      } as never;
      let worst = 0;
      for (let i = 0; i < Number(process.env.CLASS_HUNT); i++) {
        const sort = (['name', 'percent', 'activity'] as const)[i % 3];
        const stop = new Error('rollback');
        await db
          .withTenant(tenantId, async (tx) => {
            const plan = await tx.execute(
              sql`EXPLAIN (ANALYZE, BUFFERS) ${classPageStatement(a, { ...base100, sort, dir: 'asc' } as never)}`,
            );
            const text = plan.rows
              .map((r) => String(r['QUERY PLAN']))
              .join(String.fromCharCode(10));
            const t = Number(/Execution Time: ([0-9.]+)/.exec(text)?.[1] ?? 0);
            if (t > worst) {
              worst = t;
              writeFileSync(
                planFile('progress-plan-worst.txt'),
                `sort=${sort} run=${i}${String.fromCharCode(10)}${text}`,
              );
            }
            throw stop;
          })
          .catch((e) => {
            if (e !== stop) throw e;
          });
      }
      say(
        `   hunt: slowest of ${process.env.CLASS_HUNT} runs ${worst} ms (plan in <tmpdir>/progress-plan-worst.txt)`,
      );
    }

    // ------------------------------------------------------------------ 3. aggregation vs counters
    say(
      '## 3. aggregation (the progress rows) vs counters (one row per learner and module, kept by a trigger)',
    );
    await owner.query('CREATE SCHEMA IF NOT EXISTS bench_counters');
    await owner.query(
      'DROP TABLE IF EXISTS bench_counters.module_done, bench_counters.progress_copy',
    );
    await owner.query(
      `CREATE TABLE bench_counters.module_done (
         tenant_id uuid NOT NULL, participant_id uuid NOT NULL, module_id uuid NOT NULL, done integer NOT NULL,
         PRIMARY KEY (tenant_id, participant_id, module_id))`,
    );
    await owner.query(
      `INSERT INTO bench_counters.module_done
       SELECT ip.tenant_id, ip.participant_id, i.module_id, count(*) FILTER (WHERE ip.status = 'completed')
         FROM lms.item_progress ip JOIN lms.content_items i ON i.tenant_id = ip.tenant_id AND i.id = ip.item_id
        WHERE ip.tenant_id = $1 GROUP BY 1, 2, 3`,
      [tenantId],
    );
    await owner.query('ANALYZE bench_counters.module_done');
    // the same page of 100 learners with their percentage per module and overall
    const countersRead = `
      WITH tot AS (SELECT module_id, count(*)::int AS n FROM lms.content_items
                    WHERE tenant_id = $1 AND offering_id = $2 AND required AND published AND deleted_at IS NULL GROUP BY 1),
           grand AS (SELECT sum(n)::int AS n FROM tot),
           pp AS (SELECT p.id FROM lms.course_participants p
                   WHERE p.tenant_id = $1 AND p.offering_id = $2 AND p.participation = 'learner' AND p.status = 'active'
                   ORDER BY p.id LIMIT 100)
      SELECT pp.id,
             round(100.0 * coalesce(sum(c.done), 0) / (SELECT n FROM grand))::int AS percent,
             jsonb_agg(jsonb_build_object('m', t.module_id, 'p', round(100.0 * coalesce(c.done, 0) / t.n)::int)) AS modules
        FROM pp CROSS JOIN tot t
        LEFT JOIN bench_counters.module_done c ON c.tenant_id = $1 AND c.participant_id = pp.id AND c.module_id = t.module_id
       GROUP BY pp.id`;
    const countersTime = await time(30, () => owner.query(countersRead, [tenantId, offeringId]));
    say(
      `   READ, page of 100 learners: aggregation median ${(await time(30, () => view({}))).median} ms ` +
        `(the product's full query: filters, status, sort, keyset, total) vs counters median ${countersTime.median} ms ` +
        '(percentages only, no status / filters / total)',
    );
    // write cost: complete one item. A scratch copy of the rows, with and without the trigger that keeps the counter
    await owner.query(
      `CREATE TABLE bench_counters.progress_copy AS
         SELECT * FROM lms.item_progress WHERE tenant_id = $1 AND status = 'in_progress'`,
      [tenantId],
    );
    await owner.query('ALTER TABLE bench_counters.progress_copy ADD COLUMN module_id uuid');
    await owner.query(
      `UPDATE bench_counters.progress_copy c SET module_id = i.module_id
         FROM lms.content_items i WHERE i.tenant_id = c.tenant_id AND i.id = c.item_id`,
    );
    await owner.query(
      'ALTER TABLE bench_counters.progress_copy ADD PRIMARY KEY (tenant_id, participant_id, item_id)',
    );
    const targets = (
      await owner.query<{ participant_id: string; item_id: string }>(
        'SELECT participant_id, item_id FROM bench_counters.progress_copy ORDER BY item_id, participant_id LIMIT 4000',
      )
    ).rows;
    const complete = async () => {
      const t0 = performance.now();
      for (const r of targets.slice(0, 2000)) {
        await owner.query(
          `UPDATE bench_counters.progress_copy SET status = 'completed', completed_at = now(), completed_how = 'manual'
            WHERE tenant_id = $1 AND participant_id = $2 AND item_id = $3`,
          [tenantId, r.participant_id, r.item_id],
        );
      }
      return (performance.now() - t0) / 2000;
    };
    const without = await complete();
    await owner.query(
      "UPDATE bench_counters.progress_copy SET status = 'in_progress', completed_at = NULL, completed_how = NULL",
    );
    await owner.query(
      `CREATE FUNCTION bench_counters.bump() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
           INSERT INTO bench_counters.module_done (tenant_id, participant_id, module_id, done)
           VALUES (NEW.tenant_id, NEW.participant_id, NEW.module_id, 1)
           ON CONFLICT (tenant_id, participant_id, module_id) DO UPDATE SET done = bench_counters.module_done.done + 1;
         END IF;
         RETURN NEW;
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER bump AFTER UPDATE ON bench_counters.progress_copy
         FOR EACH ROW EXECUTE FUNCTION bench_counters.bump()`,
    );
    const withCounter = await complete();
    say(
      `   WRITE, complete one item (one statement, autocommit): ${Math.round(without * 1000) / 1000} ms without a counter, ` +
        `${Math.round(withCounter * 1000) / 1000} ms with the trigger (+${Math.round((withCounter / without - 1) * 100)} %)`,
    );
    say(
      '   A counter must also be repaired set-based whenever the DENOMINATOR changes (an item added, unpublished, ' +
        'archived, a module opening): that touches every learner of the offering, here ' +
        `${LEARNERS} x ${MODULES} counter rows per change.`,
    );
    await owner.query('DROP SCHEMA bench_counters CASCADE');
  } finally {
    await app?.close().catch(() => undefined);
    await db?.close?.().catch(() => undefined);
    await owner.query('DROP SCHEMA IF EXISTS bench_counters CASCADE').catch(() => undefined);
    try {
      await owner.query('ROLLBACK').catch(() => undefined); // a failed set-up leaves its transaction open
      await owner.query('BEGIN');
      await deleteTenantCascade(owner, tenantId);
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK').catch(() => undefined);
      console.error('cleanup failed (run pnpm db:dev:clean):', err);
    }
    await owner.end();
  }
  console.log(`\n--- summary ---\n${out.join('\n')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
