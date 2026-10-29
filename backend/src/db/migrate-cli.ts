import { EnvError, loadDotEnv, parseMigrateEnv } from '../config/env';
import { passwordFromUrl } from '../config/secrets';
import { sslWarning } from '../config/ssl';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseMigrateEnv();
  if (passwordFromUrl(env.DATABASE_APP_URL) !== env.LMS_APP_PASSWORD) {
    throw new EnvError(['LMS_APP_PASSWORD: must equal the password inside DATABASE_APP_URL']);
  }
  const warn = sslWarning(env);
  if (warn) console.warn(`WARNING: ${warn}`);
  const result = await runMigrations({
    ownerUrl: env.DATABASE_URL,
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    appPassword: env.LMS_APP_PASSWORD,
    log: (m) => console.log(m),
  });
  console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} up to date`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'migration failed');
  process.exit(1);
});
