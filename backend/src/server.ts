import { buildApp } from './app';
import { loadDotEnv, parseApiEnv, resolvePoolMax } from './config/env';
import { createLogger } from './config/logger';
import { sslWarning } from './config/ssl';
import { createDb } from './db/client';
import { assertDatabaseVersion } from './db/pg-version';

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseApiEnv();
  const logger = createLogger(env);
  const warning = sslWarning(env);
  if (warning) logger.warn(warning);

  const db = createDb({
    url: env.DATABASE_APP_URL,
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    max: resolvePoolMax(env),
    applicationName: 'lms-api',
    onError: (err) => logger.error({ err }, 'idle database client error'),
  });
  const app = buildApp({ env, db, logger });

  // Warm the pool before taking traffic so the first readiness probe doesn't pay for the
  // TCP+TLS handshake. Failure is not fatal: /health/ready reports it.
  await db.ping(15_000).catch((err: unknown) => logger.warn({ err }, 'database warm-up failed'));
  // a wrong PostgreSQL major is fatal (an unreachable database is not: /health/ready reports it)
  await assertDatabaseVersion(db).catch((err: unknown) => {
    if (err instanceof Error && /PostgreSQL \d+ is required/.test(err.message)) throw err;
    logger.warn({ err }, 'database version check skipped');
  });

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
      await app.close(); // stop accepting, drain in-flight requests
      await db.close(); // then close the pool
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

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'failed to start');
  process.exit(1);
});
