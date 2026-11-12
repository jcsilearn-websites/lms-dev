import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv, parseOwnerEnv, resolvePoolMax } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { deleteTenantCascade } from '../src/db/dev-cleanup';

// Step 10 benchmark, against the DEV database, with a throwaway college ("bench-<random>") that is deleted in a `finally`
// block together with its stored files (see docs/benchmarks.md, "Step 10"):
//   1. THE DEADLINE BURST: LEARNERS learners (default 1,500) hand in in the last minutes before a due date: 70% one PDF of
//      about 2 MB, 20% text, 10% three files. Files go through the storage abstraction (signed URL, the API streams the bytes
//      to disk and never buffers them). Two loads: SATURATION (everybody at once, as fast as the machine goes) and PACED
//      (arrivals spread over BENCH_PACED_SECONDS with a rising density, most of them in the last seconds).
//   2. THE GRADING QUEUE and the class status for QUEUE_LEARNERS learners (default 500): first open (the keys are made),
//      pages, filters, the summary, one learner, a grade, a release, the final scores.
//   3. THE ZIP of those QUEUE_LEARNERS submissions (one file of ZIP_FILE_KB each, default 2,048 KB): time, throughput and the
//      peak memory of the API process (the archive is streamed, so it must stay flat).
// The college has NO table statistics on purpose (a freshly loaded tenant, see "Planner lesson" in CLAUDE.md) and autovacuum is
// paused on the tables of the run so it cannot analyze mid-run and hide a bad plan.
//
//   pnpm --filter @lms/backend run bench:assignments      BENCH_LEARNERS=1500 BENCH_CONNECTIONS=64

const LEARNERS = Number(process.env.BENCH_LEARNERS ?? 1500);
const QUEUE_LEARNERS = Math.min(Number(process.env.BENCH_QUEUE_LEARNERS ?? 500), LEARNERS);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 64);
const FAIR_SECONDS = Number(process.env.BENCH_FAIR_SECONDS ?? 60);
const PACED_SECONDS = Number(process.env.BENCH_PACED_SECONDS ?? 180);
const FILE_KB = Number(process.env.BENCH_FILE_KB ?? 2048);
const ZIP_FILE_KB = Number(process.env.BENCH_ZIP_FILE_KB ?? 2048);

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0
    ? 0
    : (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number);
};

interface Reply {
  status: number;
  body: Buffer;
  ms: number;
  /** `Deadline-Receipt` of a 503 busy (the signed proof of when the request arrived) */
  receipt: string | null;
  /** epoch ms at which the request was sent */
  sentAt: number;
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
  const tenantId = newId();
  const out: string[] = [];
  const say = (s: string) => {
    out.push(s);
    console.log(s);
  };
  const tables = [
    'files',
    'assignment_uploads',
    'submissions',
    'submission_files',
    'assignment_grades',
    'assignment_learners',
    'item_progress',
  ];
  const env = parseApiEnv({
    ...process.env,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_LOGIN_PER_IP: '100000',
    RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
    RATE_LIMIT_MAX: '10000000',
  });
  const storageDir = path.resolve(env.STORAGE_LOCAL_DIR);
  const tenantDir = path.join(storageDir, tenantId);

  let app: ReturnType<typeof buildApp> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  const statementCount = { n: 0 };
  try {
    for (const t of tables)
      await owner.query(`ALTER TABLE lms.${t} SET (autovacuum_enabled = false)`);
    await mkdir(tenantDir, { recursive: true });

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
    await owner.query(
      "INSERT INTO lms.courses (id, tenant_id, code, title) VALUES ($1, $2, 'BENCH', 'Bench course')",
      [courseId, tenantId],
    );
    const burstOffering = newId();
    const queueOffering = newId();
    for (const [i, o] of [burstOffering, queueOffering].entries())
      await owner.query(
        "INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, label, status) VALUES ($1, $2, $3, $4, $5, 'published')",
        [o, tenantId, courseId, termId, i === 0 ? 'burst' : 'queue'],
      );
    // the burst offering has every learner; the queue offering the first QUEUE_LEARNERS of them
    await owner.query(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
       SELECT lms.uuid_v7(), m.tenant_id, $2, m.id,
              CASE WHEN m.user_id = $3 THEN 'instructor' ELSE 'learner' END::lms.participation_type, 'manual'
         FROM lms.tenant_memberships m WHERE m.tenant_id = $1`,
      [tenantId, burstOffering, instructorId],
    );
    await owner.query(
      `INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
       SELECT lms.uuid_v7(), m.tenant_id, $2, m.id,
              CASE WHEN m.user_id = $3 THEN 'instructor' ELSE 'learner' END::lms.participation_type, 'manual'
         FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND (m.user_id = $3 OR CASE WHEN u.email ~ '^l[0-9]+@' THEN (substring(u.email from 2 for position('@' in u.email) - 2))::int <= ${QUEUE_LEARNERS} ELSE false END)`,
      [tenantId, queueOffering, instructorId],
    );
    // sessions for every learner and the instructor (the login hashes a password: minutes for 1,500 of them)
    const userRows = (
      await owner.query<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM lms.users u WHERE u.email LIKE '%@${slug}.test' ORDER BY u.email`,
      )
    ).rows;
    const tokenOf = new Map<string, string>();
    const hashes: string[] = [];
    const uids: string[] = [];
    for (const r of userRows) {
      const token = randomBytes(32).toString('base64url');
      tokenOf.set(r.email, token);
      hashes.push(createHash('sha256').update(token).digest('hex'));
      uids.push(r.id);
    }
    await owner.query(
      `INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at)
       SELECT lms.uuid_v7(), decode(x.h, 'hex'), x.uid, $1, now() + interval '1 day', now() + interval '2 days'
         FROM unnest($2::text[], $3::uuid[]) AS x(h, uid)`,
      [tenantId, hashes, uids],
    );
    const moduleOf = new Map<string, string>();
    for (const o of [burstOffering, queueOffering]) {
      const m = newId();
      moduleOf.set(o, m);
      await owner.query(
        "INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published) VALUES ($1, $2, $3, 'Work', 'm1', true)",
        [m, tenantId, o],
      );
    }
    const item = async (offering: string, title: string, position: string) => {
      const id = newId();
      await owner.query(
        `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, published, completion)
         VALUES ($1, $2, $3, $4, 'assignment', $5, $6, true, 'on_submit')`,
        [id, tenantId, offering, moduleOf.get(offering), title, position],
      );
      await owner.query(
        `UPDATE lms.assignments SET due_at = now() + interval '1 hour', allow_text = true, max_files = 3, max_file_mb = 10,
                max_points = 100 WHERE tenant_id = $1 AND item_id = $2`,
        [tenantId, id],
      );
      return id;
    };
    const saturationItem = await item(burstOffering, 'Burst (saturation)', 'i1');
    const pacedItem = await item(burstOffering, 'Burst (paced)', 'i2');
    const queueItem = await item(queueOffering, 'Queue', 'i1');
    await owner.query('COMMIT');
    say(
      `## college: ${LEARNERS} learners, ${QUEUE_LEARNERS} in the queue offering, no table statistics`,
    );

    // ------------------------------------------------------------------ the app
    db = createDb({
      url: env.DATABASE_APP_URL,
      ssl: env.DB_SSL,
      sslCa: env.DB_SSL_CA,
      max: resolvePoolMax(env),
      applicationName: 'lms-bench-assignments',
      onStatement: () => {
        statementCount.n++;
      },
    });
    app = buildApp({ env, db, logger: createLogger(env) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(CONNECTIONS, LEARNERS) });
    const call = (
      method: string,
      urlPath: string,
      cookie: string,
      body?: Buffer | string,
      extra: Record<string, string> = {},
    ): Promise<Reply> =>
      new Promise((resolve, reject) => {
        const t0 = performance.now();
        const sentAt = Date.now();
        const payload = body === undefined ? undefined : Buffer.from(body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method,
            path: urlPath,
            agent,
            headers: {
              host,
              origin: `http://${host}`,
              'x-requested-with': 'lms',
              cookie: `sid=${cookie}`,
              ...(payload ? { 'content-length': String(payload.length) } : {}),
              ...extra,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks),
                ms: performance.now() - t0,
                receipt: (res.headers['deadline-receipt'] as string | undefined) ?? null,
                sentAt,
              }),
            );
          },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    /**
     * The SPA's way: a 503 `busy` is answered after Retry-After + backoff + jitter, with the receipt of the FIRST refusal in
     * `X-Deadline-Receipt` (every hand-in call is idempotent). `trace` collects what a fairness check needs.
     */
    const busy = { n: 0 };
    const callRetry = async (
      method: string,
      urlPath: string,
      cookie: string,
      body?: Buffer | string,
      extra: Record<string, string> = {},
      trace?: { firstSentAt: number; busy: number; lastSentAt: number },
    ): Promise<Reply> => {
      let receipt: string | null = null;
      let r = await call(method, urlPath, cookie, body, extra);
      if (trace) trace.firstSentAt = r.sentAt;
      for (let i = 1; i <= 12 && r.status === 503; i++) {
        busy.n++;
        if (trace) trace.busy++;
        receipt = receipt ?? r.receipt;
        const wait = Math.max(2000, Math.min(15_000, 1000 * 2 ** (i - 1)));
        await new Promise((res) => setTimeout(res, wait + Math.random() * 1000 * Math.min(i, 5)));
        r = await call(method, urlPath, cookie, body, {
          ...extra,
          ...(receipt ? { 'x-deadline-receipt': receipt } : {}),
        });
      }
      if (trace) trace.lastSentAt = r.sentAt;
      return r;
    };
    const json = (r: Reply) => JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;
    const instructor = tokenOf.get(`teacher@${slug}.test`) as string;
    const learnerToken = (n: number) => tokenOf.get(`l${n}@${slug}.test`) as string;
    const A = (offering: string, itemId: string) =>
      `/api/offerings/${offering}/items/${itemId}/assignment`;
    const JSONH = { 'content-type': 'application/json' };

    // ------------------------------------------------------------------ 1. the deadline burst
    const pdf = (kb: number, tag: string) =>
      Buffer.concat([
        Buffer.from(`%PDF-1.4\n%${tag}\n`),
        Buffer.alloc(kb * 1024, 0x61),
        Buffer.from('\n%%EOF\n'),
      ]);
    const big = pdf(FILE_KB, 'burst');
    const small = pdf(Math.max(1, Math.round(FILE_KB / 3)), 'three');

    interface Steps {
      request: number[];
      put: number[];
      confirm: number[];
      finalize: number[];
      flow: number[];
      failed: number;
      reasons: Map<string, number>;
      /** per learner: when the finalize was first sent, how often it was refused busy, when the accepted one was sent */
      finalizes: Map<number, { firstSentAt: number; busy: number; lastSentAt: number }>;
    }
    const emptySteps = (): Steps => ({
      request: [],
      put: [],
      confirm: [],
      finalize: [],
      flow: [],
      failed: 0,
      reasons: new Map(),
      finalizes: new Map(),
    });

    const fail = (steps: Steps, step: string, r: Reply) => {
      steps.failed++;
      const key = `${step} -> ${r.status} ${r.body.toString('utf8').slice(0, 120)}`;
      steps.reasons.set(key, (steps.reasons.get(key) ?? 0) + 1);
    };

    /** One learner's whole hand-in: 70% one PDF, 20% text, 10% three files. */
    const handIn = async (n: number, itemId: string, steps: Steps) => {
      const t0 = performance.now();
      const cookie = learnerToken(n);
      const kind = n % 10 < 7 ? 'one' : n % 10 < 9 ? 'text' : 'three';
      const files = kind === 'one' ? [big] : kind === 'three' ? [small, small, small] : [];
      const ids: string[] = [];
      for (const [i, f] of files.entries()) {
        const req = await callRetry(
          'POST',
          `${A(burstOffering, itemId)}/files`,
          cookie,
          JSON.stringify({ name: `w${n}-${i}.pdf`, size: f.length }),
          JSONH,
        );
        steps.request.push(req.ms);
        if (req.status !== 201) {
          fail(steps, 'upload request', req);
          return;
        }
        const target = json(req) as {
          fileId: string;
          upload: { url: string; headers: Record<string, string> };
        };
        const put = await callRetry('PUT', target.upload.url, cookie, f, {
          ...target.upload.headers,
          'content-length': String(f.length),
        });
        steps.put.push(put.ms);
        if (put.status !== 204) {
          fail(steps, 'PUT', put);
          return;
        }
        const conf = await callRetry(
          'POST',
          `${A(burstOffering, itemId)}/files/${target.fileId}/confirm`,
          cookie,
          '{}',
          JSONH,
        );
        steps.confirm.push(conf.ms);
        if (conf.status !== 200) {
          fail(steps, 'confirm', conf);
          return;
        }
        ids.push(target.fileId);
      }
      const trace = { firstSentAt: 0, busy: 0, lastSentAt: 0 };
      steps.finalizes.set(n, trace);
      const fin = await callRetry(
        'POST',
        `${A(burstOffering, itemId)}/submissions`,
        cookie,
        JSON.stringify({
          requestKey: newId(),
          fileIds: ids,
          ...(kind === 'text' ? { text: `my answer ${n}` } : {}),
        }),
        JSONH,
        trace,
      );
      steps.finalize.push(fin.ms);
      if (fin.status !== 200) fail(steps, 'finalize', fin);
      steps.flow.push(performance.now() - t0);
    };
    const safeHandIn = async (n: number, itemId: string, steps: Steps) => {
      try {
        await handIn(n, itemId, steps);
      } catch (err) {
        steps.failed++;
        const key = `network: ${(err as Error).message}`;
        steps.reasons.set(key, (steps.reasons.get(key) ?? 0) + 1);
      }
    };
    const report = (label: string, s: Steps, wall: number, stmts: number) => {
      const row = (name: string, xs: number[]) =>
        xs.length === 0
          ? ''
          : `\n     ${name}: n=${xs.length}, p50 ${round(pct(xs, 50))} ms, p95 ${round(pct(xs, 95))} ms, p99 ${round(pct(xs, 99))} ms, max ${round(Math.max(...xs))} ms`;
      say(
        `   ${label}: ${s.flow.length} hand-ins in ${round(wall / 1000, 1)} s (${s.failed} failed, ${busy.n} busy answers retried), ${stmts} statements = ${Math.round(stmts / (wall / 1000))}/s${row('upload request', s.request)}${row('PUT (the API streams to disk)', s.put)}${row('confirm (reads and hashes the bytes)', s.confirm)}${row('FINALIZE', s.finalize)}${row('whole flow of one learner', s.flow)}`,
      );
      for (const [k, n] of s.reasons) say(`     FAILED x${n}: ${k}`);
      if (s.failed > 0) throw new Error(`${label}: ${s.failed} hand-ins failed`);
    };
    const pool = async (n: number, work: (i: number) => Promise<void>) => {
      let next = 1;
      await Promise.all(
        Array.from({ length: CONNECTIONS }, async () => {
          while (true) {
            const i = next++;
            if (i > n) return;
            await work(i);
          }
        }),
      );
    };

    say('## 1. the deadline burst (70% one PDF, 20% text, 10% three files)');
    {
      const steps = emptySteps();
      busy.n = 0;
      const s0 = statementCount.n;
      const t0 = performance.now();
      await pool(LEARNERS, (i) => safeHandIn(i, saturationItem, steps));
      report(
        `saturation: everybody at once, ${CONNECTIONS} in flight`,
        steps,
        performance.now() - t0,
        statementCount.n - s0,
      );
      const n = Number(
        (
          await owner.query(
            'SELECT count(DISTINCT participant_id)::int AS n FROM lms.submissions WHERE assignment_item_id = $1',
            [saturationItem],
          )
        ).rows[0]?.n,
      );
      if (n !== LEARNERS) throw new Error(`expected ${LEARNERS} submitters, found ${n}`);
    }
    {
      const steps = emptySteps();
      busy.n = 0;
      const s0 = statementCount.n;
      const t0 = performance.now();
      // arrival times with a rising density: t = W * sqrt(u), so most learners come in the last seconds
      const arrivals = Array.from({ length: LEARNERS }, (_, i) => ({
        n: i + 1,
        at: PACED_SECONDS * 1000 * Math.sqrt(Math.random()),
      }));
      await Promise.all(
        arrivals.map(async (a) => {
          await new Promise((r) => setTimeout(r, a.at));
          await safeHandIn(a.n, pacedItem, steps);
        }),
      );
      report(
        `paced: ${LEARNERS} arrivals over ${PACED_SECONDS} s, rising density`,
        steps,
        performance.now() - t0,
        statementCount.n - s0,
      );
    }

    // ------------------------------------------------------------------ 1b. fairness: the burst squeezed across the deadline
    // The due date is FAIR_SECONDS from now (late work allowed for another hour, so a late mark is recorded, not refused). The
    // learners start with a rising density over most of that time, so many finalizes are sent just before the deadline and are
    // refused busy, then retried AFTER it. The rule: a finalize whose FIRST send was before the due date is never marked late
    // (a retry that went through after the due date counts from the first arrival, by the receipt); one first sent after it is.
    say(`## 1b. fairness: ${LEARNERS} hand-ins squeezed across a deadline ${FAIR_SECONDS} s away`);
    {
      const fairItem = await item(burstOffering, 'Burst (fairness)', 'i3');
      const dueAt = Date.now() + FAIR_SECONDS * 1000;
      await owner.query(
        `UPDATE lms.assignments SET due_at = to_timestamp($3::double precision / 1000),
                late_policy = 'allowed', late_cutoff_at = to_timestamp($3::double precision / 1000) + interval '1 hour',
                penalty_kind = 'flat', penalty_value = 10, penalty_cap = 50
          WHERE tenant_id = $1 AND item_id = $2`,
        [tenantId, fairItem, dueAt],
      );
      const steps = emptySteps();
      busy.n = 0;
      const s0 = statementCount.n;
      const t0 = performance.now();
      const arrivals = Array.from({ length: LEARNERS }, (_, i) => ({
        n: i + 1,
        at: FAIR_SECONDS * 1000 * 0.9 * Math.sqrt(Math.random()),
      }));
      await Promise.all(
        arrivals.map(async (a) => {
          await new Promise((r) => setTimeout(r, a.at));
          await safeHandIn(a.n, fairItem, steps);
        }),
      );
      report(
        `fairness: ${LEARNERS} arrivals over ${round(FAIR_SECONDS * 0.9)} s before a deadline at ${FAIR_SECONDS} s`,
        steps,
        performance.now() - t0,
        statementCount.n - s0,
      );
      const rows = (
        await owner.query<{ n: number; late: number; grace: boolean }>(
          `SELECT (substring(u.email from 2 for position('@' in u.email) - 2))::int AS n, s.late_seconds AS late, s.on_grace AS grace
             FROM lms.submissions s
             JOIN lms.course_participants p ON p.tenant_id = s.tenant_id AND p.id = s.participant_id
             JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
             JOIN lms.users u ON u.id = m.user_id
            WHERE s.tenant_id = $1 AND s.assignment_item_id = $2 AND s.version_no = 1`,
          [tenantId, fairItem],
        )
      ).rows;
      let unfair = 0;
      let protectedByReceipt = 0;
      let lateAfter = 0;
      let lateRetries = 0;
      let onTime = 0;
      for (const r of rows) {
        const t = steps.finalizes.get(r.n);
        if (!t) continue;
        const before = t.firstSentAt <= dueAt;
        if (r.late > 0) {
          if (before) unfair++;
          else lateAfter++;
        } else onTime++;
        if (before && t.busy > 0 && t.lastSentAt > dueAt && r.late === 0) protectedByReceipt++;
        if (!before && t.busy > 0) lateRetries++;
      }
      say(
        `   ${rows.length} hand-ins: ${onTime} on time, ${lateAfter} late (first sent after the deadline: correct), ` +
          `**${unfair} unfair late marks** (first sent before the deadline, marked late); ` +
          `${protectedByReceipt} finalizes were refused busy before the deadline, accepted only after it, and stayed on time ` +
          `(protected by the receipt); ${lateRetries} late ones were also refused busy.`,
      );
      if (rows.length !== LEARNERS)
        throw new Error(`expected ${LEARNERS} submitters, found ${rows.length}`);
      if (unfair > 0) throw new Error(`${unfair} unfair late marks`);
    }

    // ------------------------------------------------------------------ 2. the grading queue for QUEUE_LEARNERS
    say(
      `## 2. the grading queue and the class status for ${QUEUE_LEARNERS} learners (a college without statistics)`,
    );
    const filesDir = tenantDir;
    const zipBytes = pdf(ZIP_FILE_KB, 'zip');
    const master = path.join(filesDir, 'master.bin');
    await writeFile(master, zipBytes);
    // the submissions of the queue assignment: written straight into the tables, one stored object each (hard links of ONE
    // file: the disk holds the data once, the API reads it QUEUE_LEARNERS times)
    const parts = (
      await owner.query<{ pid: string; n: number }>(
        `SELECT p.id AS pid, (substring(u.email from 2 for position('@' in u.email) - 2))::int AS n
           FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
           JOIN lms.users u ON u.id = m.user_id
          WHERE p.offering_id = $1 AND p.participation = 'learner' ORDER BY n`,
        [queueOffering],
      )
    ).rows;
    const fileIds = parts.map(() => newId());
    for (const id of fileIds) await link(master, path.join(tenantDir, id));
    await owner.query(
      `WITH p AS (SELECT x.pid, x.fid, x.n FROM unnest($3::uuid[], $4::uuid[], $5::int[]) AS x (pid, fid, n)),
       f AS (INSERT INTO lms.files (id, tenant_id, storage_key, original_name, content_type, declared_size, size_bytes, sha256, status, created_by, confirmed_at)
             SELECT fid, $1, $9::text || '/' || fid::text, 'work-' || n || '.pdf', 'application/pdf', $6, $6, repeat('0', 64), 'ready', $7, now() FROM p RETURNING id),
       s AS (INSERT INTO lms.submissions (id, tenant_id, assignment_item_id, offering_id, participant_id, version_no, request_key, late_seconds)
             SELECT lms.uuid_v7(), $1, $2, $8, pid, 1, lms.uuid_v7(), CASE WHEN n % 7 = 0 THEN 3600 ELSE 0 END FROM p RETURNING id, participant_id)
       INSERT INTO lms.submission_files (tenant_id, submission_id, file_id, position)
       SELECT $1, s.id, p.fid, 1 FROM s JOIN p ON p.pid = s.participant_id`,
      [
        tenantId,
        queueItem,
        parts.map((x) => x.pid),
        fileIds,
        parts.map((x) => x.n),
        zipBytes.length,
        instructorId,
        queueOffering,
        tenantId,
      ],
    );
    const Q = A(queueOffering, queueItem);
    const timed = async (label: string, f: () => Promise<Reply>, extra?: (r: Reply) => string) => {
      const r = await f();
      if (r.status >= 300)
        throw new Error(`${label}: ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
      say(`   ${label}: ${round(r.ms)} ms${extra ? ` (${extra(r)})` : ''}`);
      return r;
    };
    const loop = async (label: string, n: number, f: () => Promise<Reply>) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = await f();
        if (r.status >= 300)
          throw new Error(`${label}: ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
        ms.push(r.ms);
      }
      say(
        `   ${label}: p50 ${round(pct(ms, 50))} ms, p95 ${round(pct(ms, 95))} ms, max ${round(Math.max(...ms))} ms over ${n} calls`,
      );
    };
    const get = (urlPath: string) => () => call('GET', urlPath, instructor);
    await timed(
      'first open of the queue (makes the random keys of all learners, then reads)',
      get(`${Q}/grading/queue?limit=50`),
      (r) => `${(json(r).items as unknown[]).length} rows`,
    );
    await loop('queue page, 50 rows, default order', 30, get(`${Q}/grading/queue?limit=50`));
    await loop('queue page, 100 rows, by time', 30, get(`${Q}/grading/queue?limit=100&sort=time`));
    await loop('queue, status=late', 30, get(`${Q}/grading/queue?status=late&limit=50`));
    await loop('class status (the summary)', 30, get(`${Q}/grading/summary`));
    const first = json(await call('GET', `${Q}/grading/queue?limit=1`, instructor)) as {
      items: { learnerKey: string }[];
    };
    const key = first.items[0]?.learnerKey as string;
    await loop('one learner for grading', 30, get(`${Q}/grading/learners/${key}`));
    const detail = json(await call('GET', `${Q}/grading/learners/${key}`, instructor)) as {
      submissions: { id: string }[];
    };
    await loop('save a grade', 30, () =>
      call(
        'PUT',
        `${Q}/grading/learners/${key}/grade`,
        instructor,
        JSON.stringify({ submissionId: detail.submissions[0]?.id, rawScore: 80 }),
        JSONH,
      ),
    );
    // grade everybody (one statement per learner here, the way a person works), then release all
    const all: { learnerKey: string }[] = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const r = json(await call('GET', `${Q}/grading/queue?limit=100${after}`, instructor)) as {
        items: { learnerKey: string }[];
        nextCursor: string | null;
      };
      all.push(...r.items);
      if (!r.nextCursor) break;
      after = `&after=${encodeURIComponent(r.nextCursor)}`;
    }
    say(
      `   the queue paged to the end: ${all.length} learners in ${Math.ceil(all.length / 100)} pages of 100`,
    );
    await owner.query(
      `INSERT INTO lms.assignment_grades (tenant_id, assignment_item_id, participant_id, submission_id, raw_score, graded_by)
       SELECT $1, $2, s.participant_id, s.id, 70, $3 FROM lms.submissions s WHERE s.tenant_id = $1 AND s.assignment_item_id = $2
       ON CONFLICT DO NOTHING`,
      [tenantId, queueItem, instructorId],
    );
    await timed(
      'release every grade (one statement, the penalty frozen on each)',
      () => call('POST', `${Q}/release`, instructor, '{}', JSONH),
      (r) => `${json(r).released as number} released`,
    );
    const t0 = performance.now();
    const scores = await owner.query(
      'SELECT count(*)::int AS n FROM lms.assignment_final_scores($1, $2)',
      [tenantId, queueOffering],
    );
    say(
      `   final scores of the offering (the gradebook interface): ${round(performance.now() - t0)} ms for ${scores.rows[0]?.n} learners`,
    );

    // ------------------------------------------------------------------ 3. the ZIP
    say(
      `## 3. the ZIP of ${QUEUE_LEARNERS} submissions (one file of ${ZIP_FILE_KB} KB each, ${round((QUEUE_LEARNERS * ZIP_FILE_KB) / 1024)} MB of data)`,
    );
    {
      let peak = process.memoryUsage().rss;
      const base = peak;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 25);
      const t1 = performance.now();
      let bytes = 0;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: `${Q}/submissions.zip`,
            agent,
            headers: {
              host,
              origin: `http://${host}`,
              'x-requested-with': 'lms',
              cookie: `sid=${instructor}`,
            },
          },
          (res) => {
            res.on('data', (c: Buffer) => {
              bytes += c.length;
            });
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
      clearInterval(sampler);
      const ms = performance.now() - t1;
      if (status !== 200) throw new Error(`zip: ${status}`);
      say(
        `   GET submissions.zip: ${round(bytes / 1048576)} MB in ${round(ms / 1000, 2)} s = ${round(bytes / 1048576 / (ms / 1000))} MB/s; API process RSS ${round(base / 1048576)} MB before, peak ${round(peak / 1048576)} MB (+${round((peak - base) / 1048576)} MB) while streaming`,
      );
    }
    agent.destroy();
  } finally {
    await app?.close();
    await db?.close();
    await rm(tenantDir, { recursive: true, force: true });
    await owner.query('ROLLBACK').catch(() => undefined);
    await owner.query('BEGIN');
    await deleteTenantCascade(owner, tenantId);
    await owner.query('COMMIT');
    for (const t of tables) await owner.query(`ALTER TABLE lms.${t} RESET (autovacuum_enabled)`);
    await owner.end();
    console.log('\n(the throwaway college and its files are deleted)');
    void out;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
