import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { parseEnv, workerEnvSchema } from '../src/config/env';
import { startWorker } from '../src/worker';
import { getTestDatabases } from './support';

const silent = pino({ level: 'silent' });

function env(url?: string) {
  const dbs = getTestDatabases();
  return parseEnv(workerEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_APP_URL: url ?? dbs.appUrl,
    DB_SSL: dbs.ssl,
  });
}

describe('worker lifecycle', () => {
  it('boots, connects to the database and shuts down gracefully (idempotent stop)', async () => {
    const worker = await startWorker(env(), silent);
    // the purges are scheduled: a system job per time slot on the queue
    expect(worker.scheduled).toBe(6);
    expect(Object.keys(worker.handlers).sort()).toEqual([
      'auth.purge_tokens',
      'content.copy', // enqueued by a large copy: not scheduled
      'courses.sync', // queued by database triggers: not scheduled
      'files.purge',
      'imports.process', // enqueued by confirm: not scheduled
      'imports.purge',
      'imports.reap',
      'invites.send', // enqueued by the import: not scheduled
      'jobs.purge',
      'sessions.purge_dead',
    ]);
    await worker.stop();
    await worker.stop();
  });

  it('fails fast when the database is unreachable', async () => {
    await expect(
      startWorker(env('postgresql://lms_app:x@127.0.0.1:1/postgres'), silent),
    ).rejects.toThrow();
  });
});
