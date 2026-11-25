import { pathToFileURL } from 'node:url';
import { createModules, modulesConfigFromEnv } from '../composition';
import { type ApiEnv, EnvError, loadDotEnv, parseApiEnv, resolvePoolMax } from '../config/env';
import { createLogger } from '../config/logger';
import { createDb } from '../db/client';

// After a RESTORE of an older backup, the people who were erased since that backup are erased AGAIN from the erasure ledger
// (ids only, kept outside the database: core/erasure-ledger.ts). Run it once the restored database is migrated and BEFORE the
// application accepts traffic:
//   pnpm privacy:reapply-erasures --yes
// It is idempotent (a person who is already erased is skipped; a person the restored database does not know is "nothing to do"),
// so running it twice is harmless. It connects as lms_app, like the worker.

export interface ReapplyResult {
  entries: number;
  reapplied: number;
  already: number;
  nothing: number;
  /** an account whose college erasure was not re-applied yet: run the command again */
  blocked: number;
}

export async function reapplyErasures(env: ApiEnv): Promise<ReapplyResult> {
  const db = createDb({
    url: env.DATABASE_APP_URL,
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    max: resolvePoolMax(env),
    queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS ?? 0,
    applicationName: 'lms-privacy-reapply',
  });
  try {
    const logger = createLogger(env);
    const modules = createModules(db, modulesConfigFromEnv(env, logger));
    return await modules.privacy.erasureService.reapplyFromLedger();
  } finally {
    await db.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  if (!process.argv.includes('--yes')) {
    throw new Error(
      'This erases the people in the erasure ledger from the CURRENT database. Run it after a restore, with --yes.',
    );
  }
  const r = await reapplyErasures(parseApiEnv());
  console.log(
    `erasure ledger: ${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}; erased again ${r.reapplied}, already erased ${r.already}, not in this database ${r.nothing}${r.blocked > 0 ? `, WAITING for a college erasure ${r.blocked} (run the command again)` : ''}`,
  );
  if (r.blocked > 0) process.exitCode = 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(
      err instanceof EnvError ? err.message : err instanceof Error ? err.message : 'failed',
    );
    process.exit(1);
  });
}
