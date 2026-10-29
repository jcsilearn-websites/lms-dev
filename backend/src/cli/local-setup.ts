import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { EnvError, loadDotEnv, parseOwnerEnv } from '../config/env';
import { isLocalHost } from '../config/local';
import { connectionConfig } from '../db/connection';

// One-time setup of a LOCAL PostgreSQL cluster for development (no Docker needed):
//   pnpm db:local:setup
// Creates the Supabase-compatible roles `anon` and `authenticated` (CI does the same, so migrations behave
// identically everywhere) and the development database named in DATABASE_URL if it does not exist yet.
// It refuses anything that is not localhost / 127.0.0.1, and production.

/** Creates anon / authenticated (cluster-level roles) when they are missing. Idempotent. */
export async function ensureCompatRoles(client: pg.Client): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END
    $$`);
}

/** CREATE DATABASE when it does not exist (names are validated identifiers: [a-z0-9_]). */
export async function ensureDatabase(client: pg.Client, name: string): Promise<boolean> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unsafe database name "${name}"`);
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount) return false;
  await client.query(`CREATE DATABASE ${name}`);
  return true;
}

/** The owner URL pointed at the maintenance database `postgres` (where CREATE DATABASE runs). */
export function maintenanceUrl(ownerUrl: string): string {
  const u = new URL(ownerUrl);
  u.pathname = '/postgres';
  return u.toString();
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.NODE_ENV === 'production')
    throw new EnvError(['refusing: NODE_ENV is production']);
  const env = parseOwnerEnv();
  const url = new URL(env.DATABASE_URL);
  if (!isLocalHost(url.hostname)) {
    throw new EnvError([
      `refusing: DATABASE_URL host "${url.hostname}" is not localhost / 127.0.0.1`,
    ]);
  }
  const dbName = url.pathname.slice(1);
  const client = new pg.Client(
    connectionConfig(maintenanceUrl(env.DATABASE_URL), env.DB_SSL, env.DB_SSL_CA),
  );
  await client.connect();
  try {
    await ensureCompatRoles(client);
    console.log('roles anon / authenticated: ready');
    const created = await ensureDatabase(client, dbName);
    console.log(`database ${dbName}: ${created ? 'created' : 'already exists'}`);
  } finally {
    await client.end();
  }
  console.log('next: pnpm db:migrate && pnpm db:seed');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'failed');
    process.exit(1);
  });
}
