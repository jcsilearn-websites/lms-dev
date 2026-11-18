import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { createModules, type Modules, modulesConfigFromEnv } from './composition';
import { loadDotEnv, parseWorkerEnv, resolvePoolMax, type WorkerEnv } from './config/env';
import { createLogger } from './config/logger';
import { sslWarning } from './config/ssl';
import { setupTelemetry } from './config/telemetry';
import { startHealthServer } from './core/health-server';
import { startScheduler } from './core/scheduler';
import { createDb } from './db/client';
import { assertDatabaseVersion } from './db/pg-version';
import { createJobRunner } from './modules/jobs';

export interface Worker {
  handlers: Modules['handlers'];
  /** Number of handlers that are scheduled (a system job is enqueued every `everyMs`). */
  scheduled: number;
  /** The job runner (polling, concurrency, lease heartbeat); exposed for tests. */
  runner: ReturnType<typeof createJobRunner>;
  /** Readiness for the worker's health port: the database answers and the queue loop is alive. */
  ready(
    maxIdleSeconds: number,
  ): Promise<{ ok: boolean; details: Record<string, string | number | boolean> }>;
  /** The modules (the ops gauges register on them). */
  modules: Modules;
  /** Stops accepting work, lets in-flight work finish, then closes the DB pool. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Boots the background worker: connects to the database (as lms_app), wires the modules (same
 * composition root as the API), fails fast if the database is unreachable, then runs the job queue:
 * a runner that claims and executes jobs for every module handler, and a scheduler that enqueues the
 * handlers that declare `everyMs` (one system job per time slot, however many workers run).
 */
export async function startWorker(env: WorkerEnv, logger: Logger): Promise<Worker> {
  const db = createDb({
    url: env.DATABASE_APP_URL,
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    max: resolvePoolMax(env),
    queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS ?? 0,
    applicationName: 'lms-worker',
    onError: (err) => logger.error({ err }, 'idle database client error'),
  });
  try {
    await db.ping(10_000);
    await assertDatabaseVersion(db);
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }
  const modules = createModules(db, modulesConfigFromEnv(env, logger));
  const { handlers } = modules;
  const jobs = modules.jobs.service;
  const runner = createJobRunner({
    jobs,
    handlers,
    config: jobs.config,
    workerId: `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`,
    logger,
  });
  runner.start();
  // Scheduled handlers (the purges) are enqueued, not run here: the queue gives them retries, a lease
  // and "once per slot" across instances.
  const scheduler = startScheduler(handlers, {
    enqueue: (name, everyMs) => jobs.schedule(name, everyMs),
    onError: (name, err) => logger.error({ handler: name, err }, 'could not enqueue scheduled job'),
  });
  logger.info(
    { handlers: Object.keys(handlers).length, scheduled: scheduler.scheduled },
    'worker started, database connected',
  );

  let stopping: Promise<void> | undefined;
  return {
    handlers,
    runner,
    modules,
    scheduled: scheduler.scheduled,
    async ready(maxIdleSeconds) {
      const idle = Math.round(runner.idleMs() / 1000);
      const db_ = await db.ping(2000).then(
        () => true,
        () => false,
      );
      return {
        ok: db_ && !stopping && idle <= maxIdleSeconds,
        details: { db: db_ ? 'up' : 'down', queueIdleSeconds: idle, stopping: Boolean(stopping) },
      };
    },
    stop() {
      stopping ??= (async () => {
        logger.info('worker stopping');
        await scheduler.stop(); // no more scheduled enqueues
        await runner.stop(); // in-flight jobs finish within the grace period, the rest is released
        // the SMTP provider keeps a small connection pool: close it (other providers have nothing to close)
        (modules.email.provider as { close?: () => void }).close?.();
        await db.close();
        logger.info('worker stopped');
      })();
      return stopping;
    },
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseWorkerEnv();
  const logger = createLogger(env, undefined, 'lms-worker');
  const warning = sslWarning(env);
  if (warning) logger.warn(warning);

  const telemetry = setupTelemetry(env, 'lms-worker');
  const worker = await startWorker(env, logger);
  // The health port is an aid, not the job: a port that is taken (two workers on one machine in development) is a warning, not a crash
  const health =
    env.WORKER_HEALTH_PORT > 0
      ? await startHealthServer({
          port: env.WORKER_HEALTH_PORT,
          host: env.WORKER_HEALTH_HOST,
          ready: () => worker.ready(env.WORKER_READY_MAX_POLL_AGE_SECONDS),
          metricsToken: env.METRICS_TOKEN,
          renderMetrics: telemetry ? () => telemetry.renderMetrics() : undefined,
        }).catch((err: unknown) => {
          logger.warn({ err, port: env.WORKER_HEALTH_PORT }, 'worker health port unavailable');
          return null;
        })
      : null;
  if (health) logger.info({ port: health.port }, 'worker health port listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await health?.close();
      await worker.stop();
      await telemetry?.shutdown().catch(() => {});
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    process.exit(1);
  });

  // keep the event loop alive until a signal arrives
  setInterval(() => {}, 60_000);
}

// Run only when executed directly (node dist/worker.js / tsx src/worker.ts), not when tests import it.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'failed to start');
    process.exit(1);
  });
}
