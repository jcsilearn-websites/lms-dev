import pg from 'pg';
import { EnvError, loadDotEnv, parseOwnerEnv } from '../config/env';
import { sslWarning } from '../config/ssl';
import { connectionConfig } from '../db/connection';
import { cleanDevNoise } from '../db/dev-cleanup';

// DEV-ONLY maintenance script: removes benchmark tenants and the sessions / auth audit noise that
// local use leaves in the development database. It deletes rows (as the owner role), so it refuses
// to run unless it is certain it is looking at the dev project:
//   pnpm db:dev:clean --yes --project-ref <ref of DATABASE_URL>
// Refuses when: NODE_ENV=production, running on Cloud Run (K_SERVICE), the host is not a Supabase
// pooler / localhost, DATABASE_URL is the same project as TEST_DATABASE_URL, or the typed project
// ref does not match DATABASE_URL (typing the ref is the confirmation).

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const refOf = (url: string): string => {
  const user = decodeURIComponent(new URL(url).username);
  return user.includes('.') ? user.slice(user.indexOf('.') + 1) : '';
};

export function assertDevDatabase(
  env: { NODE_ENV: string; DATABASE_URL: string },
  extra: {
    testUrl?: string | undefined;
    cloudRun?: string | undefined;
    yes: boolean;
    typedRef?: string | undefined;
  },
): void {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production') problems.push('NODE_ENV is production');
  if (extra.cloudRun) problems.push('running on Cloud Run (K_SERVICE is set)');
  const host = new URL(env.DATABASE_URL).hostname;
  const devHost =
    host === 'localhost' || host === '127.0.0.1' || host.endsWith('.pooler.supabase.com');
  if (!devHost) problems.push(`host "${host}" is not a Supabase pooler or localhost`);
  const ref = refOf(env.DATABASE_URL);
  if (extra.testUrl && ref !== '' && ref === refOf(extra.testUrl)) {
    problems.push('DATABASE_URL is the same project as TEST_DATABASE_URL');
  }
  // local PostgreSQL has no project ref: compare database NAMES. The test databases are
  // <TEST base name> and <TEST base name>_<n> (one per worker): none of them may be cleaned here.
  if (extra.testUrl && ref === '') {
    const dbName = decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1));
    const testBase = decodeURIComponent(new URL(extra.testUrl).pathname.slice(1));
    if (dbName === testBase || new RegExp(`^${testBase}_\\d+$`).test(dbName)) {
      problems.push('DATABASE_URL names a test database (TEST_DATABASE_URL base name)');
    }
  }
  if (!extra.yes) problems.push('missing --yes');
  // a local database has no project ref: the confirmation is the word "local"
  const expectedRef = ref === '' ? 'local' : ref;
  if (extra.typedRef !== expectedRef) {
    problems.push(
      `--project-ref must be "${expectedRef === 'local' ? 'local' : 'the project ref in DATABASE_URL'}"`,
    );
  }
  if (problems.length > 0) {
    throw new EnvError([`refusing to clean: ${problems.join('; ')}`]);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseOwnerEnv();
  assertDevDatabase(env, {
    testUrl: process.env.TEST_DATABASE_URL,
    cloudRun: process.env.K_SERVICE,
    yes: process.argv.includes('--yes'),
    typedRef: arg('project-ref'),
  });
  const warning = sslWarning(env);
  if (warning) console.warn(`WARNING: ${warning}`);

  const client = new pg.Client(connectionConfig(env.DATABASE_URL, env.DB_SSL, env.DB_SSL_CA));
  await client.connect();
  try {
    const r = await cleanDevNoise(client);
    console.log(
      `dev database cleaned: ${r.benchTenants} bench tenants, ${r.sessions} sessions, ${r.tokens} tokens, ` +
        `${r.tenantAudit} tenant audit rows, ${r.platformAudit} platform audit rows`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

// run only when executed directly, so tests can import assertDevDatabase
const entry = process.argv[1] ?? '';
if (/dev-clean\.[cm]?[jt]s$/.test(entry)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'failed');
    process.exit(1);
  });
}
