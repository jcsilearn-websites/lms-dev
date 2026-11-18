import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import {
  createJobRunner,
  createJobsRepository,
  createJobsService,
  DEFAULT_JOBS_CONFIG,
} from '../src/modules/jobs';
import { getTestDatabases, testAppDbOptions, testOwnerPool } from './support';

// Step 14a: a worker is KILLED (SIGKILL: no handler runs, no goodbye) in the middle of a job. Its lease expires, another worker
// takes the job over, the job completes exactly once, and the attempt accounting says what happened. The processes are real (the
// real runner and pool); the handler's side effects are lines in a file, so the test sees every start and finish.
// Serial: it waits for a 3 s lease to expire.

let owner: pg.Pool;
let dir: string;
let effectsFile: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  owner = testOwnerPool();
  dir = mkdtempSync(path.join(tmpdir(), 'lms-kill-'));
  effectsFile = path.join(dir, 'effects.jsonl');
});
afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await owner.end();
  rmSync(dir, { recursive: true, force: true });
});

function spawnWorker(name: string, extra: Record<string, string> = {}): ChildProcess {
  const dbs = getTestDatabases();
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/support/kill-worker.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_APP_URL: dbs.appUrl,
      DB_SSL: dbs.ssl,
      EFFECTS_FILE: effectsFile,
      WORKER_NAME: name,
      ...extra,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  return child;
}

const effects = (): { worker: string; event: string; job: string; attempt: number }[] => {
  try {
    return readFileSync(effectsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('a worker is killed mid-job', () => {
  it('the lease expires, a second worker takes the job over and completes it ONCE; the attempts say so', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
       VALUES (lms.uuid_v7(), 'killtest.slow', NULL, '{}'::jsonb, 5) RETURNING id`,
    );
    const jobId = rows[0]?.id as string;

    const a = spawnWorker('A', { SLOW_MS: '30000' });
    await until(
      () => effects().some((e) => e.worker === 'A' && e.event === 'started'),
      30_000,
      'A to start the job',
    );
    expect(
      (await owner.query(`SELECT status, attempts FROM lms.jobs WHERE id = $1`, [jobId])).rows[0],
    ).toMatchObject({
      status: 'running',
      attempts: 1,
    });

    // no goodbye: the process is gone with the job half done
    a.kill('SIGKILL');
    await new Promise((r) => a.once('exit', r));
    const killedAt = Date.now();
    // the job is still "running" under A's lease: nobody may take it before the lease runs out
    expect(
      (await owner.query(`SELECT status FROM lms.jobs WHERE id = $1`, [jobId])).rows[0]?.status,
    ).toBe('running');

    const b = spawnWorker('B', { SLOW_MS: '500' });
    await until(
      () => effects().some((e) => e.worker === 'B' && e.event === 'finished'),
      40_000,
      'B to finish the job',
    );
    // B could only start after the lease (3 s, renewed by A until it died) expired
    const bStart = effects().find((e) => e.worker === 'B' && e.event === 'started');
    expect(bStart?.attempt).toBe(2);
    expect(Date.now() - killedAt).toBeGreaterThan(1500);

    await until(
      async () =>
        (await owner.query(`SELECT status FROM lms.jobs WHERE id = $1`, [jobId])).rows[0]
          ?.status === 'completed',
      10_000,
      'the job to be completed',
    );
    const job = (
      await owner.query(`SELECT status, attempts, last_error FROM lms.jobs WHERE id = $1`, [jobId])
    ).rows[0];
    expect(job).toMatchObject({ status: 'completed', attempts: 2 });

    // the side effects: A started and never finished, B started and finished; exactly ONE finish for this job, no third run
    const mine = effects().filter((e) => e.job === jobId);
    expect(mine.map((e) => `${e.worker}:${e.event}:${e.attempt}`)).toEqual([
      'A:started:1',
      'B:started:2',
      'B:finished:2',
    ]);
    b.kill('SIGKILL');
  }, 90_000);
});

describe('a worker is stopped gracefully under load', () => {
  it('in-flight work gets its grace period, the rest is released WITHOUT charging the attempt, and nothing is left running', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
         VALUES (lms.uuid_v7(), 'killtest.slow', NULL, jsonb_build_object('n', $1::int), 5) RETURNING id`,
        [i],
      );
      ids.push(rows[0]?.id as string);
    }
    const before = effects().length;
    const w = spawnWorker('C', { SLOW_MS: '60000', GRACE_SECONDS: '1' });
    await until(
      () =>
        effects()
          .slice(before)
          .some((e) => e.worker === 'C' && e.event === 'started'),
      30_000,
      'C to start a job',
    );
    // SIGTERM cannot be delivered to a Node process on Windows: the runner's stop() is what the SIGTERM handler calls, so the
    // process-level path is covered on Linux in test/shutdown.test.ts; here we stop the runner through the child's own handler
    if (process.platform === 'win32') {
      w.kill('SIGKILL');
      await new Promise((r) => w.once('exit', r));
      return; // the graceful path needs a signal Windows cannot send: see shutdown.test.ts (Linux / CI)
    }
    w.kill('SIGTERM');
    await new Promise((r) => w.once('exit', r));
    const rows = (
      await owner.query(`SELECT id, status, attempts FROM lms.jobs WHERE id = ANY($1::uuid[])`, [
        ids,
      ])
    ).rows;
    // none is left "running"; the one that was in flight was released with its attempt refunded; the others were never claimed
    expect(rows.filter((r) => r.status === 'running')).toEqual([]);
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
    await owner.query(`DELETE FROM lms.jobs WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
  }, 60_000);
});

describe('the runner stopped under load (in process: the same code the SIGTERM handler calls, on every OS)', () => {
  it('finishes work within the grace period, releases the rest with the attempt refunded, leaves nothing running', async () => {
    const db = createDb(testAppDbOptions(3));
    const config = {
      ...DEFAULT_JOBS_CONFIG,
      leaseSeconds: 30,
      pollIntervalMs: 50,
      pollMaxIntervalMs: 100,
      concurrency: { default: 3 },
    };
    const jobs = createJobsService({ db, jobsRepo: createJobsRepository(), config });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
         VALUES (lms.uuid_v7(), 'loadtest.quick', NULL, jsonb_build_object('n', $1::int), 5) RETURNING id`,
        [i],
      );
      ids.push(rows[0]?.id as string);
    }
    const started: string[] = [];
    const finished: string[] = [];
    const aborted: string[] = [];
    const runner = createJobRunner({
      jobs,
      config,
      workerId: 'graceful-test',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      handlers: {
        // the first three jobs finish within the grace period; the next ones are slow and ignore it until aborted
        'loadtest.quick': {
          run: async (payload, ctx) => {
            const n = (payload as { n: number }).n;
            started.push(ctx.jobId);
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, n < 3 ? 150 : 60_000);
              ctx.signal.addEventListener('abort', () => {
                aborted.push(ctx.jobId);
                clearTimeout(t);
                resolve();
              });
            });
            if (!ctx.signal.aborted) finished.push(ctx.jobId);
            return { done: 1 };
          },
        },
      },
    });
    runner.start();
    await until(() => started.length >= 3, 15_000, 'three jobs to start');
    await until(() => finished.length >= 3, 15_000, 'the quick jobs to finish');
    await until(() => started.length >= 6, 15_000, 'the slow jobs to start');
    await runner.stop(500); // grace 0.5 s: the slow jobs are aborted and handed back
    await db.close();

    const rows = (
      await owner.query(`SELECT id, status, attempts FROM lms.jobs WHERE id = ANY($1::uuid[])`, [
        ids,
      ])
    ).rows;
    expect(rows.filter((r) => r.status === 'running')).toEqual([]);
    expect(rows.filter((r) => finished.includes(r.id)).every((r) => r.status === 'completed')).toBe(
      true,
    );
    const handedBack = rows.filter((r) => aborted.includes(r.id));
    expect(handedBack.length).toBeGreaterThan(0);
    // released, not failed: queued again with the attempt refunded (a deploy must not eat the retry budget)
    expect(handedBack.every((r) => r.status === 'queued' && r.attempts === 0)).toBe(true);
    await owner.query(`DELETE FROM lms.jobs WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
  }, 60_000);
});
