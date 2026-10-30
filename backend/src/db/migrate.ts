import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { passwordFromUrl, redactSecrets } from '../config/secrets';
import type { DbSsl } from '../config/ssl';
import { connectionConfig } from './connection';
import { assertSupportedPostgres } from './pg-version';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// Arbitrary constant: concurrent migrators serialise on this advisory lock.
const ADVISORY_LOCK_KEY = 726_000_001;

export interface MigrateOptions {
  ownerUrl: string;
  ssl: DbSsl;
  sslCa?: string | undefined;
  /** Password to set on role lms_app after migrating. Never logged; redacted from errors. */
  appPassword: string;
  migrationsDir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  /** True only when the lms_app password was (re)set on this run. */
  passwordChanged: boolean;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Versioned SQL migrations: lms.schema_migrations(filename, checksum, applied_at), serialised by
 * pg_advisory_lock, one transaction per file, and a hard failure if an applied file changed.
 */
export async function runMigrations(opts: MigrateOptions): Promise<MigrateResult> {
  const secrets = [opts.appPassword, passwordFromUrl(opts.ownerUrl)];
  const log = opts.log ?? (() => {});
  const client = new pg.Client({
    ...connectionConfig(opts.ownerUrl, opts.ssl, opts.sslCa),
    application_name: 'lms-migrate',
  });
  try {
    await client.connect();
    assertSupportedPostgres(
      (await client.query('SHOW server_version_num')).rows[0].server_version_num,
    );
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      return await migrateLocked(client, opts, log);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(message, secrets));
  } finally {
    await client.end().catch(() => {});
  }
}

async function migrateLocked(
  client: pg.Client,
  opts: MigrateOptions,
  log: (message: string) => void,
): Promise<MigrateResult> {
  await client.query('CREATE SCHEMA IF NOT EXISTS lms');
  await client.query('REVOKE ALL ON SCHEMA lms FROM PUBLIC');
  await client.query(`CREATE TABLE IF NOT EXISTS lms.schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM lms.schema_migrations',
  );
  const appliedChecksums = new Map(rows.map((r) => [r.filename, r.checksum]));

  const result: MigrateResult = { applied: [], skipped: [], passwordChanged: false };
  for (const file of files) {
    const sql = await readFile(`${dir}/${file}`, 'utf8');
    const checksum = sha256(sql);
    const previous = appliedChecksums.get(file);
    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied (checksum mismatch). Add a new migration instead.`,
        );
      }
      result.skipped.push(file);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO lms.schema_migrations (filename, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log(`applied ${file}`);
    result.applied.push(file);
  }

  // Only touch the role password when it actually changed: every ALTER ROLE invalidates the
  // pooler's cached credentials (Supabase Supavisor), which makes lms_app logins fail for a while.
  await client.query(`CREATE TABLE IF NOT EXISTS lms.role_password_state (
    role_name text PRIMARY KEY,
    fingerprint text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  const fingerprint = sha256(`lms_app:${opts.appPassword}`);
  const current = await client.query<{ fingerprint: string }>(
    "SELECT fingerprint FROM lms.role_password_state WHERE role_name = 'lms_app'",
  );
  if (current.rows[0]?.fingerprint === fingerprint) {
    log('lms_app password unchanged');
    return result;
  }

  // Role passwords cannot be bind parameters: build the statement server-side with %L quoting.
  const { rows: stmt } = await client.query<{ sql: string }>(
    "SELECT format('ALTER ROLE lms_app PASSWORD %L', $1::text) AS sql",
    [opts.appPassword],
  );
  const alter = stmt[0]?.sql;
  if (!alter) throw new Error('failed to build ALTER ROLE statement');
  await client.query(alter);
  await client.query(
    `INSERT INTO lms.role_password_state (role_name, fingerprint) VALUES ('lms_app', $1)
     ON CONFLICT (role_name) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = now()`,
    [fingerprint],
  );
  result.passwordChanged = true;
  log('lms_app password set from environment');
  return result;
}
