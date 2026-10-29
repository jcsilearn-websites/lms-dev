import { sql } from 'drizzle-orm';
import type pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv, workerEnvSchema } from '../src/config/env';
import type { HandlerMap } from '../src/core/handlers';
import { newId } from '../src/core/uuid';
import { createDb, type Database } from '../src/db/client';
import {
  createJobRunner,
  createJobsRepository,
  createJobsService,
  type JobsConfig,
} from '../src/modules/jobs';
import { startWorker } from '../src/worker';
import { expectPgError, SQLSTATE } from './helpers';
import {
  createTenantFixture,
  getTestDatabases,
  resetLms,
  type TenantFixture,
  testAppDbOptions,
  testAppPool,
  testOwnerPool,
} from './support';

// The Postgres job queue against the real test database: transactional enqueue, tenant isolation,
// SKIP LOCKED claiming, retry with backoff, dead letters, leases, release, retention and the runner.

let owner: pg.Pool;
let db: Database;
let A: TenantFixture;
let B: TenantFixture;
const silent = pino({ level: 'silent' });
const logger = { info: () => {}, warn: () => {}, error: () => {} };
let n = 0;
const queue = (p = 'q') => `${p}-${++n}-${Date.now().toString(36)}`;

const fast: Partial<JobsConfig> = {
  pollIntervalMs: 20,
  pollMaxIntervalMs: 100,
  leaseSeconds: 3,
  maxAttempts: 3,
  backoffBaseSeconds: 10,
  backoffMaxSeconds: 3600,
  concurrency: { default: 2 },
};

function service(over: Partial<JobsConfig> = {}, now?: () => number) {
  return createJobsService({
    db,
    jobsRepo: createJobsRepository(),
    config: { ...fast, ...over },
    ...(now ? { now } : {}),
  });
}

beforeAll(async () => {
  await resetLms();
  owner = testOwnerPool();
  db = createDb(testAppDbOptions(4));
  A = await createTenantFixture(owner, 'jobs-a');
  B = await createTenantFixture(owner, 'jobs-b');
});
afterAll(async () => {
  await db.close();
  await owner.end();
});

const row = async (id: string) =>
  (await owner.query('SELECT * FROM lms.jobs WHERE id = $1', [id])).rows[0];
const byQueue = async (q: string) =>
  (await owner.query('SELECT * FROM lms.jobs WHERE queue = $1 ORDER BY id', [q])).rows;
async function waitFor<T>(fn: () => Promise<T | false | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('transactional enqueue', () => {
  it('a job enqueued in the business transaction exists after commit', async () => {
    const q = queue();
    const jobs = service();
    await db.withTenant(A.tenantId, async (tx) => {
      await jobs.enqueue(tx, { queue: q, tenantId: A.tenantId, payload: { hello: 'world' } });
    });
    const rows = await byQueue(q);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: A.tenantId,
      status: 'queued',
      payload: { hello: 'world' },
      attempts: 0,
    });
  });

  it('when the business write fails, the job is rolled back with it: no job', async () => {
    const q = queue();
    const jobs = service();
    await expect(
      db.withTenant(A.tenantId, async (tx) => {
        await jobs.enqueue(tx, { queue: q, tenantId: A.tenantId });
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');
    expect(await byQueue(q)).toHaveLength(0);
  });
});

describe('tenant isolation and privileges', () => {
  it('a tenant sees only its own jobs; system jobs are invisible; cross-tenant inserts are refused', async () => {
    const q = queue();
    const jobs = service();
    await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    await db.withoutTenant((exec) => jobs.enqueue(exec, { queue: q, tenantId: null }));

    const seenByA = await db.withTenant(A.tenantId, (tx) =>
      tx.execute(sql`SELECT tenant_id FROM lms.jobs WHERE queue = ${q}`),
    );
    expect(seenByA.rows.map((r) => r.tenant_id)).toEqual([A.tenantId]);
    const seenByB = await db.withTenant(B.tenantId, (tx) =>
      tx.execute(sql`SELECT 1 FROM lms.jobs WHERE queue = ${q}`),
    );
    expect(seenByB.rows).toHaveLength(0);
    const noTenant = await db.withoutTenant((exec) =>
      exec.execute(sql`SELECT 1 FROM lms.jobs WHERE queue = ${q}`),
    );
    expect(noTenant.rows).toHaveLength(0);

    // a tenant context cannot create a job for another tenant or a system job
    await expect(
      db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: B.tenantId })),
    ).rejects.toSatisfy((e: unknown) =>
      /row-level security|42501/.test(String(e) + String((e as { cause?: unknown }).cause)),
    );
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.execute(
          sql`INSERT INTO lms.jobs (id, queue, tenant_id) VALUES (${newId()}::uuid, ${q}, NULL)`,
        ),
      ),
    ).rejects.toBeDefined();
  });

  it('lms_app cannot UPDATE or DELETE jobs directly: only the queue functions change their state', async () => {
    const client = testAppPool();
    const ac = await client.connect();
    try {
      await expectPgError(
        ac.query("UPDATE lms.jobs SET status = 'completed'"),
        SQLSTATE.insufficientPrivilege,
      );
      await expectPgError(ac.query('DELETE FROM lms.jobs'), SQLSTATE.insufficientPrivilege);
      await expectPgError(ac.query('TRUNCATE lms.jobs'), SQLSTATE.insufficientPrivilege);
    } finally {
      ac.release();
      await client.end();
    }
  });
});

describe('claiming', () => {
  it('claims due jobs oldest first, up to the limit, and marks them running with a lease', async () => {
    const q = queue();
    const jobs = service();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      await db.withTenant(A.tenantId, (tx) =>
        jobs.enqueue(tx, { queue: q, tenantId: A.tenantId, payload: { i } }),
      );
    }
    const first = await jobs.claim(q, 'w1', 3);
    expect(first.map((j) => (j.payload as { i: number }).i)).toEqual([0, 1, 2]);
    expect(first[0]).toMatchObject({ tenantId: A.tenantId, attempts: 1, maxAttempts: 3 });
    const r = await row(first[0]?.id as string);
    expect(r).toMatchObject({ status: 'running', locked_by: 'w1' });
    expect(new Date(r.locked_until).getTime()).toBeGreaterThan(Date.now());
    const rest = await jobs.claim(q, 'w1', 10);
    expect(rest).toHaveLength(1);
    expect(await jobs.claim(q, 'w1', 10)).toEqual([]);
    expect(ids).toEqual([]);
  });

  it('a job scheduled for later is not claimed before it is due', async () => {
    const q = queue();
    const jobs = service();
    await db.withTenant(A.tenantId, (tx) =>
      jobs.enqueue(tx, { queue: q, tenantId: A.tenantId, runAt: new Date(Date.now() + 3_600_000) }),
    );
    expect(await jobs.claim(q, 'w', 5)).toEqual([]);
  });

  it('concurrent claimers never get the same job (SKIP LOCKED)', async () => {
    const q = queue();
    const jobs = service();
    for (let i = 0; i < 12; i++) {
      await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    }
    const batches = await Promise.all([
      jobs.claim(q, 'w1', 6),
      jobs.claim(q, 'w2', 6),
      jobs.claim(q, 'w3', 6),
    ]);
    const all = batches.flat().map((j) => j.id);
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
  });
});

describe('retry, backoff and the dead-letter state', () => {
  async function enqueued(q: string, maxAttempts = 3) {
    const jobs = service();
    await db.withTenant(A.tenantId, (tx) =>
      jobs.enqueue(tx, { queue: q, tenantId: A.tenantId, maxAttempts }),
    );
    return { jobs, id: ((await byQueue(q))[0] as { id: string }).id };
  }

  it('a failed job is retried after an exponential, jittered backoff, then dead-lettered', async () => {
    const q = queue();
    const { jobs, id } = await enqueued(q, 3);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [claimed] = await jobs.claim(q, 'w', 1);
      expect(claimed?.id).toBe(id);
      expect(claimed?.attempts).toBe(attempt);
      const outcome = await jobs.fail(id, 'w', `boom ${attempt}`);
      if (attempt < 3) {
        expect(outcome).toBe('retry');
        const r = await row(id);
        expect(r).toMatchObject({
          status: 'queued',
          last_error: `boom ${attempt}`,
          locked_by: null,
        });
        const delay = (new Date(r.run_at).getTime() - Date.now()) / 1000;
        delays.push(delay);
        // base 10 s * 2^(attempt-1), jitter 0.75..1.25
        const nominal = 10 * 2 ** (attempt - 1);
        expect(delay).toBeGreaterThan(nominal * 0.75 - 2);
        expect(delay).toBeLessThan(nominal * 1.25 + 1);
        expect(await jobs.claim(q, 'w', 1)).toEqual([]); // not due yet
        await owner.query(
          "UPDATE lms.jobs SET run_at = now() - interval '1 second' WHERE id = $1",
          [id],
        );
      } else {
        expect(outcome).toBe('dead');
      }
    }
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    const dead = await row(id);
    expect(dead).toMatchObject({
      status: 'dead',
      attempts: 3,
      last_error: 'boom 3',
      locked_by: null,
    });
    expect(dead.finished_at).not.toBeNull();
    expect(await jobs.claim(q, 'w', 1)).toEqual([]); // a dead job is never run again
  });

  it('the backoff is capped', async () => {
    const q = queue();
    const jobs = service({ backoffBaseSeconds: 1000, backoffMaxSeconds: 30 });
    await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    const [c] = await jobs.claim(q, 'w', 1);
    await jobs.fail(c?.id as string, 'w', 'x');
    const r = (await byQueue(q))[0];
    expect((new Date(r.run_at).getTime() - Date.now()) / 1000).toBeLessThan(30 * 1.25 + 1);
  });

  it('complete stores the result; only the lease holder can finish or fail a job', async () => {
    const q = queue();
    const { jobs, id } = await enqueued(q);
    await jobs.claim(q, 'owner-worker', 1);
    expect(await jobs.complete(id, 'someone-else', { x: 1 })).toBe(false);
    expect(await jobs.fail(id, 'someone-else', 'nope')).toBe('lost');
    expect(await jobs.extendLease(id, 'someone-else')).toBe(false);
    expect(await jobs.complete(id, 'owner-worker', { deleted: 4 })).toBe(true);
    expect(await row(id)).toMatchObject({
      status: 'completed',
      result: { deleted: 4 },
      locked_by: null,
    });
    expect(await jobs.complete(id, 'owner-worker', {})).toBe(false); // already finished
  });
});

describe('leases (crash recovery) and release', () => {
  it('a job whose worker died is re-claimed after the lease expires; the old worker cannot finish it', async () => {
    const q = queue();
    const jobs = service();
    await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    const [first] = await jobs.claim(q, 'dead-worker', 1);
    expect(await jobs.claim(q, 'other', 1)).toEqual([]); // lease still valid
    await owner.query(
      "UPDATE lms.jobs SET locked_until = now() - interval '1 second' WHERE id = $1",
      [first?.id],
    );
    const [again] = await jobs.claim(q, 'other', 1);
    expect(again).toMatchObject({ id: first?.id, attempts: 2 });
    expect(await jobs.complete(first?.id as string, 'dead-worker', {})).toBe(false);
    expect(await jobs.complete(first?.id as string, 'other', {})).toBe(true);
  });

  it('extending the lease keeps the job from being re-claimed', async () => {
    const q = queue();
    const jobs = service({ leaseSeconds: 3 });
    await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    const [c] = await jobs.claim(q, 'w', 1);
    await owner.query(
      "UPDATE lms.jobs SET locked_until = now() + interval '1 second' WHERE id = $1",
      [c?.id],
    );
    expect(await jobs.extendLease(c?.id as string, 'w')).toBe(true);
    const r = await row(c?.id as string);
    expect(new Date(r.locked_until).getTime() - Date.now()).toBeGreaterThan(1500);
  });

  it('a job whose lease expires after its LAST attempt is dead-lettered, not run again', async () => {
    const q = queue();
    const jobs = service();
    await db.withTenant(A.tenantId, (tx) =>
      jobs.enqueue(tx, { queue: q, tenantId: A.tenantId, maxAttempts: 1 }),
    );
    const [c] = await jobs.claim(q, 'w', 1);
    await owner.query(
      "UPDATE lms.jobs SET locked_until = now() - interval '1 second' WHERE id = $1",
      [c?.id],
    );
    expect(await jobs.claim(q, 'w2', 1)).toEqual([]);
    expect(await row(c?.id as string)).toMatchObject({ status: 'dead' });
  });

  it('release hands the job back without charging the attempt', async () => {
    const q = queue();
    const jobs = service();
    await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    const [c] = await jobs.claim(q, 'w', 1);
    expect(await jobs.release(c?.id as string, 'not-me')).toBe(false);
    expect(await jobs.release(c?.id as string, 'w')).toBe(true);
    expect(await row(c?.id as string)).toMatchObject({
      status: 'queued',
      attempts: 0,
      locked_by: null,
    });
    const [again] = await jobs.claim(q, 'w2', 1);
    expect(again?.attempts).toBe(1);
  });
});

describe('scheduling and retention', () => {
  it('a scheduled system job is enqueued once per time slot, however often it is asked', async () => {
    const q = queue('sched');
    let clock = 10 * 3_600_000 + 5;
    const jobs = service({}, () => clock);
    expect(await jobs.schedule(q, 3_600_000)).toBe(true);
    expect(await jobs.schedule(q, 3_600_000)).toBe(false); // same slot, e.g. another worker instance
    clock += 3_600_000;
    expect(await jobs.schedule(q, 3_600_000)).toBe(true); // next slot
    const rows = await byQueue(q);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenant_id === null && r.max_attempts === 3)).toBe(true);
  });

  it('purges completed jobs after 7 days and dead ones after 30, in bounded batches', async () => {
    const q = queue('purge');
    const mk = async (status: string, daysAgo: number) => {
      await owner.query(
        `INSERT INTO lms.jobs (id, queue, status, finished_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
        [newId(), q, status, daysAgo],
      );
    };
    await mk('completed', 8);
    await mk('completed', 20);
    await mk('completed', 1); // recent: kept
    await mk('dead', 31);
    await mk('dead', 10); // dead jobs are kept for 30 days: kept
    await owner.query("INSERT INTO lms.jobs (id, queue, status) VALUES ($1, $2, 'queued')", [
      newId(),
      q,
    ]);
    const jobs = service({ purgeBatchSize: 2 });
    // 3 purgeable rows, batches of 2 -> two statements, all three gone
    expect(await jobs.purgeFinished()).toBe(3);
    const left = await byQueue(q);
    expect(left.map((r) => r.status).sort()).toEqual(['completed', 'dead', 'queued']);
    expect(await jobs.purgeFinished()).toBe(0);
  });

  it('the batch size is clamped inside the database', async () => {
    const r = await db.withoutTenant((exec) =>
      exec.execute(sql`SELECT lms.job_purge(7, 30, -5) AS n`),
    );
    expect(Number(r.rows[0]?.n)).toBeLessThanOrEqual(1);
  });
});

describe('the runner against the real queue', () => {
  beforeEach(() => undefined);

  const run = (handlers: HandlerMap, over: Partial<JobsConfig> = {}, workerId = 'runner-1') => {
    const jobs = service(over);
    const runner = createJobRunner({ jobs, handlers, config: jobs.config, workerId, logger });
    return { jobs, runner };
  };

  it('respects the per-queue concurrency limit and finishes every job', async () => {
    const q = queue('conc');
    let running = 0;
    let peak = 0;
    const { jobs, runner } = run(
      {
        [q]: {
          run: async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 150));
            running--;
            return { ok: 1 };
          },
        },
      },
      { concurrency: { [q]: 2, default: 1 } },
    );
    for (let i = 0; i < 6; i++) {
      await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    }
    runner.start();
    await waitFor(async () => (await byQueue(q)).every((r) => r.status === 'completed'));
    await runner.stop();
    expect(peak).toBe(2);
    expect((await byQueue(q)).every((r) => r.attempts === 1)).toBe(true);
  });

  it('retries a failing job with backoff and dead-letters a poison job', async () => {
    const q = queue('retry');
    const attempts = new Map<string, number>();
    const { jobs, runner } = run(
      {
        [q]: {
          run: async (payload, ctx) => {
            attempts.set(ctx.jobId, ctx.attempt);
            const kind = (payload as { kind: string }).kind;
            if (kind === 'poison' || ctx.attempt < 2)
              throw new Error(`fail ${kind} ${ctx.attempt}`);
            return { ok: 1 };
          },
        },
      },
      { backoffBaseSeconds: 1, backoffMaxSeconds: 1, maxAttempts: 2 },
    );
    await db.withTenant(A.tenantId, async (tx) => {
      await jobs.enqueue(tx, {
        queue: q,
        tenantId: A.tenantId,
        payload: { kind: 'flaky' },
        maxAttempts: 3,
      });
      await jobs.enqueue(tx, {
        queue: q,
        tenantId: A.tenantId,
        payload: { kind: 'poison' },
        maxAttempts: 2,
      });
    });
    runner.start();
    await waitFor(async () => {
      const rows = await byQueue(q);
      return (
        rows.length === 2 && rows.every((r) => r.status === 'completed' || r.status === 'dead')
      );
    });
    await runner.stop();
    const rows = await byQueue(q);
    const flaky = rows.find((r) => r.payload.kind === 'flaky');
    const poison = rows.find((r) => r.payload.kind === 'poison');
    expect(flaky).toMatchObject({ status: 'completed', attempts: 2 });
    expect(poison).toMatchObject({ status: 'dead', attempts: 2 });
    expect(poison.last_error).toContain('fail poison 2');
  });

  it('LONG JOB: a job that runs for more than two lease periods keeps its lease and is never re-claimed', async () => {
    const q = queue('long');
    let runs = 0;
    const handlers: HandlerMap = {
      [q]: {
        run: async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 7500)); // lease is 3 s: > 2 lease periods
          return { ok: 1 };
        },
      },
    };
    const first = run(handlers, { leaseSeconds: 3 }, 'runner-A');
    const second = run(handlers, { leaseSeconds: 3 }, 'runner-B'); // competes for the same queue
    await db.withTenant(A.tenantId, (tx) =>
      first.jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }),
    );
    first.runner.start();
    await new Promise((r) => setTimeout(r, 200));
    second.runner.start();
    await waitFor(async () => (await byQueue(q))[0]?.status === 'completed', 30_000);
    await first.runner.stop();
    await second.runner.stop();
    const r = (await byQueue(q))[0];
    expect(runs).toBe(1); // never started a second time
    expect(r).toMatchObject({ status: 'completed', attempts: 1 });
  }, 60_000);

  it('graceful shutdown: a job that outlives the grace period is aborted and released, then runs elsewhere', async () => {
    const q = queue('stop');
    let aborted = false;
    let finishedFirst = false;
    const slow: HandlerMap = {
      [q]: {
        run: (_p, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve(undefined);
            });
            setTimeout(() => {
              finishedFirst = true;
              resolve({ ok: 1 });
            }, 30_000);
          }),
      },
    };
    const a = run(slow, {}, 'runner-stop');
    await db.withTenant(A.tenantId, (tx) => a.jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    a.runner.start();
    await waitFor(async () => (await byQueue(q))[0]?.status === 'running');
    await a.runner.stop(300); // grace 300 ms: the job is still running
    expect(aborted).toBe(true);
    expect(finishedFirst).toBe(false);
    expect(await byQueue(q)).toMatchObject([{ status: 'queued', attempts: 0, locked_by: null }]);

    // another worker picks it up and finishes it
    const b = run({ [q]: { run: async () => ({ ok: 1 }) } }, {}, 'runner-after');
    b.runner.start();
    await waitFor(async () => (await byQueue(q))[0]?.status === 'completed');
    await b.runner.stop();
    expect((await byQueue(q))[0]).toMatchObject({ attempts: 1 });
  });

  it('a job that finishes within the grace period is completed, not released', async () => {
    const q = queue('grace');
    const a = run({
      [q]: { run: async () => new Promise((r) => setTimeout(() => r({ ok: 1 }), 400)) },
    });
    await db.withTenant(A.tenantId, (tx) => a.jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    a.runner.start();
    await waitFor(async () => (await byQueue(q))[0]?.status === 'running');
    await a.runner.stop(5000);
    expect((await byQueue(q))[0]).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('an in-process enqueue wakes a backed-off queue immediately', async () => {
    const q = queue('wake');
    const { jobs, runner } = run(
      { [q]: { run: async () => ({ ok: 1 }) } },
      { pollIntervalMs: 100, pollMaxIntervalMs: 30_000 },
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 1200)); // idle: backed off to several seconds
    expect(runner.pollIntervalMs(q)).toBeGreaterThan(100);
    const started = Date.now();
    await db.withTenant(A.tenantId, (tx) => jobs.enqueue(tx, { queue: q, tenantId: A.tenantId }));
    await waitFor(async () => (await byQueue(q))[0]?.status === 'completed', 3000);
    expect(Date.now() - started).toBeLessThan(2000);
    await runner.stop();
  });
});

describe('the worker runs scheduled purges through the queue', () => {
  it('enqueues each scheduled handler once per slot (even with two workers) and runs it to completion', async () => {
    const dbs = getTestDatabases();
    const env = parseEnv(workerEnvSchema, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_APP_URL: dbs.appUrl,
      DB_SSL: dbs.ssl,
      JOB_POLL_INTERVAL_MS: '50',
      JOB_POLL_MAX_INTERVAL_MS: '200',
    });
    await owner.query("DELETE FROM lms.jobs WHERE singleton_key LIKE '%.purge%'");
    const w1 = await startWorker(env, silent);
    const w2 = await startWorker(env, silent);
    try {
      const rows = await waitFor(async () => {
        const r = (
          await owner.query(
            "SELECT queue, status, result FROM lms.jobs WHERE singleton_key ~ '^(jobs|sessions|auth)\\.purge' ORDER BY queue",
          )
        ).rows;
        return r.length >= 3 && r.every((x) => x.status === 'completed') ? r : false;
      });
      expect(rows.map((r) => r.queue)).toEqual([
        'auth.purge_tokens',
        'jobs.purge',
        'sessions.purge_dead',
      ]);
      expect(rows.every((r) => typeof r.result?.deleted === 'number')).toBe(true);
    } finally {
      await w1.stop();
      await w2.stop();
    }
  });
});
