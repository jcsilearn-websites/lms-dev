import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HandlerMap } from '../src/core/handlers';
import { createDb } from '../src/db/client';
import { createImportsRepository, createImportsService } from '../src/modules/imports';
import { makeApp, statementCounter, type TestApp } from './app';
import { TestClient } from './client';
import {
  count,
  csv,
  STUDENT_HEADER,
  startRunner,
  upload,
  waitFor,
  waitForImport,
} from './imports-helpers';
import { installProfiler, summarizePlan } from './pg-profile';
import {
  type AuthFixture,
  createAuthFixture,
  TEST_PASSWORD,
  testAppDbOptions,
  testOwnerPool,
} from './support';

// Bulk import at scale and under failure: 10,000 rows, crash-and-resume, a processing time longer than
// one lease period, and the throughput that goes into docs/benchmarks.md.

let owner: pg.Pool;
let t: TestApp; // batches of 2 rows: many batches from a small file
let big: TestApp; // the default batch size (500): the API side
let worker: TestApp; // the worker side of `big`: its own connection pool, so its statements are counted alone
const workerStatements = statementCounter();
let A: AuthFixture;
let admin: TestClient;
let adminBig: TestClient;

// biome-ignore lint/suspicious/noExplicitAny: a test helper that returns whatever JSON the API sent
type Json = any;
const ok = (res: { statusCode: number; body: string; json(): Json }): Json => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { IMPORT_BATCH_SIZE: '2' } });
  big = makeApp({ env: { IMPORT_MAX_ROWS: '10000' } });
  worker = makeApp({
    env: { IMPORT_MAX_ROWS: '10000' },
    db: createDb({
      ...testAppDbOptions(3),
      applicationName: 'lms-test-worker',
      onStatement: workerStatements.record,
    }),
  });
  A = await createAuthFixture(owner, 'im-s');
  await t.app.ready();
  await big.app.ready();
  const login = async (app: TestApp) => {
    const c = new TestClient(app, A.host);
    expect((await c.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
    return c;
  };
  admin = await login(t);
  adminBig = await login(big);
  const mk = async (url: string, body: unknown) => ok(await admin.post(url, body)).id as string;
  const dept = await mk('/departments', { code: 'CSE', name: 'Computer Science' });
  const prog = await mk('/programs', {
    departmentId: dept,
    code: 'BE',
    name: 'B.E.',
    durationYears: 4,
  });
  const batch = await mk('/batches', {
    programId: prog,
    admissionYear: 2023,
    graduationYear: 2027,
  });
  await mk('/sections', { batchId: batch, code: 'A' });
  await mk('/sections', { batchId: batch, code: 'B' });
});

afterAll(async () => {
  await t.close();
  await big.close();
  await worker.close();
  await owner.end();
});

const studentRows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => [
    `${prefix}${i}@im-s.test`,
    `Student ${prefix}${i}`,
    `${prefix.toUpperCase()}-${i}`,
    'CSE',
    'BE',
    '2023-2027',
    i % 2 === 0 ? 'A' : 'B',
  ]);

const totals = async () => ({
  users: await count(
    owner,
    "SELECT count(*)::int AS n FROM lms.users WHERE email LIKE '%@im-s.test' AND email NOT IN ('admin@im-s.test', 'member@im-s.test')",
  ),
  memberships: await count(
    owner,
    "SELECT count(*)::int AS n FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id WHERE u.email LIKE '%@im-s.test' AND u.email NOT IN ('admin@im-s.test', 'member@im-s.test')",
  ),
  profiles: await count(
    owner,
    "SELECT count(*)::int AS n FROM lms.member_profiles p JOIN lms.tenant_memberships m ON m.id = p.membership_id JOIN lms.users u ON u.id = m.user_id WHERE u.email LIKE '%@im-s.test' AND u.email NOT IN ('admin@im-s.test', 'member@im-s.test')",
  ),
});

describe('a 10,000-row file', () => {
  it('uploads, validates and is processed in the background: correct totals, timed', async () => {
    const rows = studentRows('big', 10_000);
    const file = csv(STUDENT_HEADER, rows);
    expect(Buffer.byteLength(file)).toBeLessThan(5 * 1024 * 1024); // inside the default 5 MB limit

    // ---- upload + dry run
    t0 = Date.now();
    const statements = big.statements;
    statements.reset();
    const res = await upload(adminBig, 'students', file, { fileName: 'ten-thousand.csv' });
    const imp = ok(res);
    const uploadMs = Date.now() - t0;
    expect(imp.counts).toMatchObject({ total: 10_000, valid: 10_000, invalid: 0 });
    // round trips of the upload: lookup + BEGIN + job + one statement per 1,000 rows + validate +
    // finalize + COMMIT: a handful, whatever the number of rows
    expect(statements.count).toBeLessThanOrEqual(7 + Math.ceil(10_000 / 1000));
    process.stdout.write(
      `IMPORT-UPLOAD rows=10000 ms=${uploadMs} statements=${statements.count}\n`,
    );
    expect(await totals()).toEqual({ users: 0, memberships: 0, profiles: 0 }); // the dry run wrote nothing

    // ---- confirm + background processing with the default batch of 500 rows
    ok(await adminBig.post(`/imports/${imp.id}/confirm`, {}));
    // IMPORT_PROFILE=1: per-statement timings of the worker connection and EXPLAIN (ANALYZE, BUFFERS) of
    // the batch statements (first, middle and last batch). Run this file ALONE for meaningful numbers.
    const profiling = process.env.IMPORT_PROFILE === '1';
    const profiler = profiling
      ? installProfiler({
          applicationName: 'lms-test-worker',
          explain: ['batch_main', 'batch_counts'],
          explainNth: (_kind, nth) => nth === 1 || nth === 10 || nth === 20,
        })
      : undefined;
    t0 = Date.now();
    workerStatements.reset();
    const elu0 = performance.eventLoopUtilization();
    const cpu0 = process.cpuUsage();
    const runner = startRunner(worker, {
      queues: ['imports.process'],
      config: { leaseSeconds: 30 },
    });
    const seenProgress: number[] = [];
    const watcher = setInterval(() => {
      void adminBig.get(`/imports/${imp.id}`).then((r) => {
        const j = r.json();
        if (j.status === 'processing') seenProgress.push(j.counts.processed);
      });
    }, 1500);
    const done = await waitForImport(adminBig, imp.id, 300_000);
    clearInterval(watcher);
    const processMs = Date.now() - t0;
    const elu = performance.eventLoopUtilization(elu0);
    const cpu = process.cpuUsage(cpu0);
    await runner.stop();
    profiler?.uninstall();
    if (profiler) printProfile(profiler, processMs, elu.utilization, cpu);
    expect(done).toMatchObject({
      status: 'completed',
      counts: {
        total: 10_000,
        valid: 10_000,
        processed: 10_000,
        created: 10_000,
        skipped: 0,
        failed: 0,
      },
    });
    expect(await totals()).toEqual({ users: 10_000, memberships: 10_000, profiles: 10_000 });
    // progress was visible while it ran (the counts grow batch by batch)
    expect(new Set(seenProgress).size).toBeGreaterThan(1);
    expect(seenProgress.every((v, i) => i === 0 || v >= (seenProgress[i - 1] as number))).toBe(
      true,
    );
    // 10,000 invite jobs were enqueued (not sent), spread over time at the configured rate
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'invites.send' AND payload ->> 'importId' = $1",
        [imp.id],
      ),
    ).toBe(10_000);
    expect(
      [...big.mailer.sent, ...worker.mailer.sent].filter((m) => m.to.endsWith('@im-s.test')),
    ).toHaveLength(0);

    const perSecond = Math.round(10_000 / (processMs / 1000));
    process.stdout.write(
      `IMPORT-PROCESS rows=10000 ms=${processMs} rows_per_second=${perSecond} batches=${Math.ceil(10_000 / 500)} worker_statements=${workerStatements.count}\n`,
    );
    // generous bound for the remote database (each statement ~200 ms): this is a ceiling, not a target
    expect(processMs).toBeLessThan(240_000);
    // set-based, counted on the WORKER connection only (the test's progress polling goes through the API's
    // pool): BEGIN+context, the batch statement, the counts statement and COMMIT = 4 per 500-row batch,
    // for every batch plus the final pass that finds nothing left to pick; plus the start and finish
    // transactions (3 each), claim / complete / a few polls (6), and one lease heartbeat per third of the lease
    const batches = Math.ceil(10_000 / 500);
    const heartbeats = Math.ceil(processMs / ((30 / 3) * 1000));
    expect(workerStatements.count).toBeLessThanOrEqual(4 * (batches + 1) + 12 + heartbeats);

    // The dry run of a SMALL file in a college that now has 10,000 members must cost about the size of
    // the file, not of the college (it used to take minutes: rows x members^2), and still find the clash.
    const small = csv(STUDENT_HEADER, [
      ['big0@im-s.test', 'Student big0', 'BIG-0', 'CSE', 'BE', '2023-2027', 'A'], // an existing member, own number
      ['clash@im-s.test', 'Clash', 'BIG-5', 'CSE', 'BE', '2023-2027', 'A'], // BIG-5 belongs to big5@
      ['fresh@im-s.test', 'Fresh', 'FRESH-1', 'CSE', 'BE', '2023-2027', 'B'],
    ]);
    const tSmall = Date.now();
    const draft = ok(await upload(adminBig, 'students', small, { fileName: 'small.csv' }));
    const smallMs = Date.now() - tSmall;
    process.stdout.write(`IMPORT-SMALL-IN-BIG-COLLEGE rows=3 ms=${smallMs}
`);
    expect(smallMs).toBeLessThan(5_000);
    const invalid = ok(
      await adminBig.get(`/imports/${draft.id}/rows`, { query: 'status=invalid&limit=10' }),
    );
    expect(invalid.items.map((r: Json) => r.rowNumber)).toEqual([3]);
    expect(JSON.stringify(invalid.items[0].errors)).toMatch(/already used by another member/);
    ok(await adminBig.post(`/imports/${draft.id}/cancel`, {}));
  }, 600_000);
});

let t0 = 0;

describe('crash and resume', () => {
  it('a worker that dies mid-import: another worker resumes, totals are exact, nothing is duplicated', async () => {
    const rows = studentRows('crash', 11); // batches of 2 rows -> 6 batches
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));

    // a worker claims the job and applies 2 batches (4 rows) ... then dies: no completion, no release
    const jobs = t.app.modules.jobs.service;
    const [claimed] = await jobs.claim('imports.process', 'worker-that-dies', 1);
    expect(claimed).toMatchObject({ attempts: 1 });
    const svc = t.app.modules.imports.service;
    expect(await svc.processOneBatch(A.tenantId, imp.id)).toBe(2);
    expect(await svc.processOneBatch(A.tenantId, imp.id)).toBe(2);
    const mid = ok(await admin.get(`/imports/${imp.id}`));
    expect(mid).toMatchObject({ status: 'processing', counts: { processed: 4, total: 11 } });
    expect((await totals()).users).toBeGreaterThanOrEqual(4);

    // its lease expires; a healthy worker takes the job over and finishes it
    await owner.query(
      "UPDATE lms.jobs SET locked_until = now() - interval '1 second' WHERE id = $1",
      [claimed?.id],
    );
    const runner = startRunner(t, { queues: ['imports.process'] });
    const done = await waitForImport(admin, imp.id);
    await runner.stop();

    expect(done).toMatchObject({
      status: 'completed',
      counts: { total: 11, valid: 11, processed: 11, created: 11, skipped: 0, failed: 0 },
    });
    const job = (
      await owner.query('SELECT status, attempts FROM lms.jobs WHERE id = $1', [claimed?.id])
    ).rows[0];
    expect(job).toMatchObject({ status: 'completed', attempts: 2 });
    const per = await owner.query(
      "SELECT count(*)::int AS users, count(DISTINCT email)::int AS distinct_emails FROM lms.users WHERE email LIKE 'crash%@im-s.test'",
    );
    expect(per.rows[0]).toEqual({ users: 11, distinct_emails: 11 });
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.member_profiles WHERE register_number LIKE 'CRASH-%'",
      ),
    ).toBe(11);
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'invites.send' AND payload ->> 'importId' = $1",
        [imp.id],
      ),
    ).toBe(11); // one invite job per member, not one per attempt
  }, 300_000);

  it('a handler that throws is retried and the import still completes exactly once', async () => {
    const rows = studentRows('retry', 5);
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    const svc = t.app.modules.imports.service;
    let calls = 0;
    const handlers: HandlerMap = {
      'imports.process': {
        run: async (payload, ctx) => {
          calls++;
          if (ctx.attempt === 1) {
            await svc.processOneBatch(A.tenantId, imp.id); // half done ...
            throw new Error('transient failure after the first batch');
          }
          const r = await svc.process(
            ctx.tenantId as string,
            (payload as { importId: string }).importId,
            ctx,
          );
          return { batches: r.batches, rows: r.rows };
        },
      },
    };
    const runner = startRunner(t, {
      handlers,
      queues: ['imports.process'],
      config: { backoffBaseSeconds: 1, backoffMaxSeconds: 1 },
    });
    const done = await waitForImport(admin, imp.id);
    await runner.stop();
    expect(calls).toBe(2);
    expect(done.counts).toMatchObject({ total: 5, processed: 5, created: 5, failed: 0 });
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.users WHERE email LIKE 'retry%@im-s.test'",
      ),
    ).toBe(5);
  }, 300_000);

  it('only the LAST failed attempt marks the import failed (and frees the college for the next one)', async () => {
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, studentRows('doomed', 3))));
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    // the real service over a repository whose batch step explodes
    const real = createImportsRepository();
    const broken = createImportsService({
      db: t.db,
      importsRepo: {
        ...real,
        processBatch: async () => Promise.reject(new Error('batch exploded')),
      },
      jobsService: t.app.modules.jobs.service,
      config: { batchSize: 2 },
    });
    const ctx = (attempt: number) => ({
      signal: new AbortController().signal,
      attempt,
      maxAttempts: 3,
    });
    // attempts 1 and 2: the error is thrown (the queue retries) but the import stays in progress
    await expect(broken.process(A.tenantId, imp.id, ctx(1))).rejects.toThrow('batch exploded');
    await expect(broken.process(A.tenantId, imp.id, ctx(2))).rejects.toThrow('batch exploded');
    expect(ok(await admin.get(`/imports/${imp.id}`)).status).toBe('processing');
    // attempt 3 of 3: the queue will give up, so the import is marked failed with the reason
    await expect(broken.process(A.tenantId, imp.id, ctx(3))).rejects.toThrow('batch exploded');
    expect(ok(await admin.get(`/imports/${imp.id}`))).toMatchObject({
      status: 'failed',
      error: 'batch exploded',
    });
    expect(await totals()).toMatchObject({ users: expect.any(Number) });
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.users WHERE email LIKE 'doomed%@im-s.test'",
      ),
    ).toBe(0);
    // the college is free again
    const next = ok(await upload(admin, 'students', csv(STUDENT_HEADER, studentRows('freed', 1))));
    expect(ok(await admin.post(`/imports/${next.id}/confirm`, {})).status).toBe('queued');
    const runner = startRunner(t, { queues: ['imports.process'] });
    await waitForImport(admin, next.id);
    await runner.stop();
  }, 180_000);
});

describe('a processing time longer than one lease period', () => {
  it('the heartbeat keeps the lease: the job is never re-claimed by another worker while it runs', async () => {
    const rows = studentRows('lease', 12); // 6 batches of 2 rows
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    const svc = t.app.modules.imports.service;
    let handlerRuns = 0;
    const slow: HandlerMap = {
      'imports.process': {
        run: async (payload, ctx) => {
          handlerRuns++;
          const importId = (payload as { importId: string }).importId;
          // each batch takes 1.5 s: 6 batches = 9 s, three times the 3 s lease
          while ((await svc.processOneBatch(A.tenantId, importId)) > 0) {
            await new Promise((r) => setTimeout(r, 1500));
          }
          const r = await svc.process(ctx.tenantId as string, importId, ctx);
          return { batches: r.batches, rows: r.rows };
        },
      },
    };
    const config = { leaseSeconds: 3 };
    const first = startRunner(t, {
      handlers: slow,
      queues: ['imports.process'],
      config,
      workerId: 'slow-A',
    });
    await new Promise((r) => setTimeout(r, 300));
    const second = startRunner(t, {
      handlers: slow,
      queues: ['imports.process'],
      config,
      workerId: 'slow-B',
    });
    const done = await waitForImport(admin, imp.id, 120_000);
    await first.stop();
    await second.stop();
    expect(handlerRuns).toBe(1); // nobody took the job over
    const job = (
      await owner.query(
        "SELECT status, attempts FROM lms.jobs WHERE queue = 'imports.process' AND payload ->> 'importId' = $1",
        [imp.id],
      )
    ).rows[0];
    expect(job).toMatchObject({ status: 'completed', attempts: 1 });
    expect(done.counts).toMatchObject({ total: 12, processed: 12, created: 12 });
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.users WHERE email LIKE 'lease%@im-s.test'",
      ),
    ).toBe(12);
  }, 180_000);
});

describe('shutdown during an import', () => {
  it('a worker that stops mid-import releases the job; the next worker continues with the remaining rows', async () => {
    const rows = studentRows('stop', 10); // 5 batches
    const imp = ok(await upload(admin, 'students', csv(STUDENT_HEADER, rows)));
    ok(await admin.post(`/imports/${imp.id}/confirm`, {}));
    const svc = t.app.modules.imports.service;
    const slow: HandlerMap = {
      'imports.process': {
        run: async (payload, ctx) => {
          const importId = (payload as { importId: string }).importId;
          while (!ctx.signal.aborted && (await svc.processOneBatch(A.tenantId, importId)) > 0) {
            await new Promise((r) => setTimeout(r, 800));
          }
          if (ctx.signal.aborted) return { batches: 0, rows: 0 };
          const r = await svc.process(ctx.tenantId as string, importId, ctx);
          return { batches: r.batches, rows: r.rows };
        },
      },
    };
    const a = startRunner(t, { handlers: slow, queues: ['imports.process'], workerId: 'stopper' });
    await waitFor(async () => (await admin.get(`/imports/${imp.id}`)).json().counts.processed >= 2);
    await a.stop(200); // grace 200 ms: the import is still running -> aborted and released
    const partial = ok(await admin.get(`/imports/${imp.id}`));
    expect(partial.status).toBe('processing');
    expect(partial.counts.processed).toBeLessThan(10);
    const job = (
      await owner.query(
        "SELECT status, attempts FROM lms.jobs WHERE queue = 'imports.process' AND payload ->> 'importId' = $1",
        [imp.id],
      )
    ).rows[0];
    expect(job).toMatchObject({ status: 'queued', attempts: 0 }); // released, the attempt not charged

    const b = startRunner(t, { queues: ['imports.process'], workerId: 'successor' });
    const done = await waitForImport(admin, imp.id);
    await b.stop();
    expect(done.counts).toMatchObject({ total: 10, processed: 10, created: 10 });
    expect(
      await count(
        owner,
        "SELECT count(*)::int AS n FROM lms.users WHERE email LIKE 'stop%@im-s.test'",
      ),
    ).toBe(10);
  }, 180_000);
});

const NL = String.fromCharCode(10);

/** Prints the per-kind timing table, the per-batch breakdown and the plan summaries of IMPORT_PROFILE=1. */
function printProfile(
  profiler: ReturnType<typeof installProfiler>,
  processMs: number,
  eventLoopUtilization: number,
  cpu: NodeJS.CpuUsage,
) {
  const out: string[] = ['', '=== IMPORT PROFILE (worker connection) ==='];
  const byKind = new Map<string, { n: number; ms: number; max: number }>();
  for (const r of profiler.records) {
    const k = byKind.get(r.kind) ?? { n: 0, ms: 0, max: 0 };
    k.n += 1;
    k.ms += r.ms;
    k.max = Math.max(k.max, r.ms);
    byKind.set(r.kind, k);
  }
  out.push('kind | statements | total ms | avg ms | max ms');
  let sqlMs = 0;
  for (const [kind, k] of byKind) {
    sqlMs += k.ms;
    out.push(
      `${kind} | ${k.n} | ${k.ms.toFixed(0)} | ${(k.ms / k.n).toFixed(1)} | ${k.max.toFixed(1)}`,
    );
  }
  out.push(
    `wall ${processMs} ms; time inside worker statements ${sqlMs.toFixed(0)} ms (${((100 * sqlMs) / processMs).toFixed(0)} %);` +
      ` event-loop utilization ${(eventLoopUtilization * 100).toFixed(0)} %;` +
      ` process cpu user ${(cpu.user / 1000).toFixed(0)} ms + system ${(cpu.system / 1000).toFixed(0)} ms`,
  );
  const mains = profiler.records.filter((r) => r.kind === 'batch_main');
  const counts = profiler.records.filter((r) => r.kind === 'batch_counts');
  out.push('batch | main statement ms | counts statement ms');
  mains.forEach((m, i) => {
    out.push(`${i + 1} | ${m.ms.toFixed(0)} | ${(counts[i]?.ms ?? 0).toFixed(0)}`);
  });
  for (const p of profiler.plans) {
    out.push('', `--- EXPLAIN (ANALYZE, BUFFERS) ${p.kind} #${p.nth}: summary`);
    out.push(...summarizePlan(p.plan));
  }
  process.stdout.write(`${out.join(NL)}${NL}`);
  const file = process.env.IMPORT_PROFILE_PLANS;
  if (file) {
    writeFileSync(
      file,
      profiler.plans.map((p) => `##### ${p.kind} #${p.nth}${NL}${p.plan}${NL}`).join(NL),
    );
  }
}
