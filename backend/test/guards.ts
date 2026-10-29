import { assertSslPolicy, EnvError, parseEnv, testEnvSchema } from '../src/config/env';
import type { DbSsl } from '../src/config/ssl';
import { currentWorkerId, isRemoteDb } from './workers';

export class TestGuardError extends Error {
  constructor(message: string) {
    super(`Refusing to run tests: ${message}`);
    this.name = 'TestGuardError';
  }
}

/**
 * Identity of a Postgres "project". Supabase pooler users are <role>.<project-ref>, and the
 * pooler host is shared, so the ref suffix is what tells projects apart. (Local servers have no ref:
 * their identity is host:port/database.)
 */
export function projectKey(url: string): string {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  const dot = user.indexOf('.');
  const ref = dot === -1 ? '' : user.slice(dot + 1);
  return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}#${ref}`;
}

/** Supabase project ref (pooler username suffix), or '' if the URL has none. */
export function projectRef(url: string): string {
  const user = decodeURIComponent(new URL(url).username);
  const dot = user.indexOf('.');
  return dot === -1 ? '' : user.slice(dot + 1);
}

/** The database NAME of a URL (host does not matter: a name clash is refused on any host). */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** The URL with another database name. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface TestDatabases {
  ownerUrl: string;
  appUrl: string;
  ssl: DbSsl;
  sslCa?: string | undefined;
  /** the database this worker uses: <base>_<worker id>, or the base name outside a worker */
  name: string;
  /** TEST_DATABASE_URL's database name: workers use <base>_1 ... <base>_N */
  baseName: string;
}

/** Names we can safely CREATE DATABASE (and that cannot be mistaken for a system database). */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const SYSTEM_NAMES = new Set(['postgres', 'template0', 'template1']);

/**
 * Throws unless the TEST_* URLs exist, name the same server and database, are not the dev database
 * (same project, same project ref, or - on ANY host - the same database NAME) and the TLS policy holds.
 * The returned URLs point at THIS worker's database (VITEST_POOL_ID in `source`): <base>_<id>.
 */
export function assertTestDatabases(
  source: Record<string, string | undefined> = process.env,
): TestDatabases {
  if (source.NODE_ENV === 'production') throw new TestGuardError('NODE_ENV is production');
  let env: ReturnType<typeof parseTestEnv>;
  try {
    env = parseTestEnv(source);
  } catch (err) {
    if (err instanceof EnvError) {
      throw new TestGuardError(
        `TEST_DATABASE_URL and TEST_DATABASE_APP_URL are required and must be valid.\n${err.message}`,
      );
    }
    throw err;
  }
  const ownerKey = projectKey(env.TEST_DATABASE_URL);
  if (ownerKey !== projectKey(env.TEST_DATABASE_APP_URL)) {
    throw new TestGuardError('TEST_DATABASE_URL and TEST_DATABASE_APP_URL are different projects');
  }
  const baseName = databaseName(env.TEST_DATABASE_URL);
  if (!SAFE_NAME.test(baseName) || SYSTEM_NAMES.has(baseName)) {
    throw new TestGuardError(
      'the TEST_ database name must be lowercase letters, digits and _ (e.g. lms_test) and not a system database',
    );
  }
  // a remote database cannot be given siblings (no CREATE DATABASE): it keeps the single base database
  const worker = isRemoteDb(source) ? undefined : currentWorkerId(source);
  const name = worker === undefined ? baseName : `${baseName}_${worker}`;
  for (const dev of [env.DATABASE_URL, env.DATABASE_APP_URL]) {
    if (!dev) continue;
    const devName = databaseName(dev);
    if (devName === baseName || devName === name) {
      throw new TestGuardError(
        `the test database name "${name}" is the dev database name (refused on any host)`,
      );
    }
    const sameRef = projectRef(dev) !== '' && projectRef(dev) === projectRef(env.TEST_DATABASE_URL);
    if (projectKey(dev) === ownerKey || sameRef) {
      throw new TestGuardError('TEST_ database URLs point at the same project as the dev database');
    }
  }
  try {
    assertSslPolicy({ NODE_ENV: source.NODE_ENV ?? 'test', DB_SSL: env.DB_SSL }, [
      env.TEST_DATABASE_URL,
      env.TEST_DATABASE_APP_URL,
    ]);
  } catch (err) {
    if (err instanceof EnvError) throw new TestGuardError(err.message);
    throw err;
  }
  return {
    ownerUrl: withDatabase(env.TEST_DATABASE_URL, name),
    appUrl: withDatabase(env.TEST_DATABASE_APP_URL, name),
    ssl: env.DB_SSL,
    sslCa: env.DB_SSL_CA,
    name,
    baseName,
  };
}

function parseTestEnv(source: Record<string, string | undefined>) {
  return parseEnv(testEnvSchema, source);
}
