// A worker process for test/resilience.worker.test.ts (step 14a): the REAL job runner, jobs service and database pool, with one
// test handler whose side effects are lines in a file. The parent kills this process with SIGKILL in the middle of a job.
//   env: DATABASE_APP_URL, DB_SSL, EFFECTS_FILE, WORKER_NAME, SLOW_MS
import { appendFileSync } from 'node:fs';
import { createDb } from '../../src/db/client';
import {
  createJobRunner,
  createJobsRepository,
  createJobsService,
  DEFAULT_JOBS_CONFIG,
} from '../../src/modules/jobs';

const env = process.env;
const effects = env.EFFECTS_FILE ?? '';
const name = env.WORKER_NAME ?? 'w';
const record = (event: string, job: string, attempt: number) =>
  appendFileSync(effects, `${JSON.stringify({ worker: name, event, job, attempt })}\n`);

const db = createDb({
  url: env.DATABASE_APP_URL ?? '',
  ssl: (env.DB_SSL ?? 'off') as 'off',
  max: 2,
  applicationName: `lms-kill-${name}`,
});
const config = {
  ...DEFAULT_JOBS_CONFIG,
  leaseSeconds: 3,
  pollIntervalMs: 100,
  pollMaxIntervalMs: 200,
  concurrency: { default: 1 },
  shutdownGraceSeconds: Number(env.GRACE_SECONDS ?? 1),
};
const jobs = createJobsService({ db, jobsRepo: createJobsRepository(), config });
const runner = createJobRunner({
  jobs,
  config,
  workerId: `kill-${name}`,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  handlers: {
    'killtest.slow': {
      run: async (_payload, ctx) => {
        record('started', ctx.jobId, ctx.attempt);
        // "work": the parent kills the process while we sit here (the lease heartbeat keeps running)
        await new Promise((resolve) => setTimeout(resolve, Number(env.SLOW_MS ?? 20_000)));
        record('finished', ctx.jobId, ctx.attempt);
        return { done: 1 };
      },
    },
  },
});
runner.start();
record('ready', '-', 0);
// stay alive
setInterval(() => {}, 60_000);
process.on(
  'SIGTERM',
  () =>
    void runner
      .stop(0)
      .then(() => db.close())
      .then(() => process.exit(0)),
);
