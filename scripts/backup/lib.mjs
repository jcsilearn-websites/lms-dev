// Shared helpers of the backup scripts (backup.mjs, restore.mjs, verify-roles.mjs). Plain Node, no build step.
// Rules every script follows:
//   - a password is NEVER an argument of a process (PGPASSWORD / PG* variables only) and never printed: every message goes through redact().
//   - PostgreSQL 17 only (ADR 0014): the tools and the server are checked.
//   - the database is read through the owner connection (DATABASE_URL); nothing here connects as lms_app except the login check.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REQUIRED_MAJOR = 17;
export const MANIFEST_VERSION = 1;

/** pg lives in the backend package; the scripts at the root resolve it from there. */
const requireFromBackend = createRequire(join(REPO_ROOT, 'backend', 'package.json'));
export const pg = requireFromBackend('pg');

/** Loads the repository's .env without overriding what the environment already has. */
export function loadEnv() {
  const file = join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ------------------------------------------------------------------------------------------------ secrets
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join('***');
    out = out.split(encodeURIComponent(s)).join('***');
  }
  return out;
}

export function parseDbUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new Error('a database URL must start with postgresql://');
  }
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

export function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withCredentials(url, user, password) {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export const isLocalHost = (h) =>
  h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';

/** DB_SSL=off|no-verify|verify-full (+ DB_SSL_CA), like the application. `off` only for a local host. */
export function sslMode(host) {
  const mode = process.env.DB_SSL ?? (isLocalHost(host) ? 'off' : '');
  if (!['off', 'no-verify', 'verify-full'].includes(mode)) {
    throw new Error(
      'DB_SSL must be off, no-verify or verify-full (off is allowed for a local database only)',
    );
  }
  if (mode === 'off' && !isLocalHost(host))
    throw new Error('DB_SSL=off is refused for a database that is not on this machine');
  if (mode === 'verify-full' && !process.env.DB_SSL_CA)
    throw new Error('DB_SSL=verify-full needs DB_SSL_CA');
  return mode;
}

export function clientConfig(url) {
  const c = parseDbUrl(url);
  const mode = sslMode(c.host);
  const ssl =
    mode === 'off'
      ? false
      : mode === 'no-verify'
        ? { rejectUnauthorized: false }
        : { ca: readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  return { ...c, ssl, connectionTimeoutMillis: 20_000 };
}

/** Environment for the PostgreSQL command line tools: the connection without a password on a command line. */
export function pgEnv(url, application = 'lms-backup') {
  const c = parseDbUrl(url);
  const mode = sslMode(c.host);
  return {
    PGHOST: c.host,
    PGPORT: String(c.port),
    PGUSER: c.user,
    PGPASSWORD: c.password,
    PGDATABASE: c.database,
    PGSSLMODE: mode === 'off' ? 'disable' : mode === 'no-verify' ? 'require' : 'verify-full',
    ...(mode === 'verify-full' ? { PGSSLROOTCERT: process.env.DB_SSL_CA } : {}),
    PGCONNECT_TIMEOUT: '20',
    PGAPPNAME: application,
  };
}

export async function connect(url, application = 'lms-backup') {
  const client = new pg.Client({ ...clientConfig(url), application_name: application });
  await client.connect();
  return client;
}

// ------------------------------------------------------------------------------------------------ the tools
const exe = process.platform === 'win32' ? '.exe' : '';

function candidateDirs() {
  const dirs = [];
  if (process.env.PG_BIN_DIR) dirs.push(process.env.PG_BIN_DIR);
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean));
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
      Boolean,
    )) {
      dirs.push(join(base, 'PostgreSQL', String(REQUIRED_MAJOR), 'bin'));
    }
  } else {
    dirs.push(`/usr/lib/postgresql/${REQUIRED_MAJOR}/bin`, `/usr/pgsql-${REQUIRED_MAJOR}/bin`);
    dirs.push(
      `/opt/homebrew/opt/postgresql@${REQUIRED_MAJOR}/bin`,
      `/usr/local/opt/postgresql@${REQUIRED_MAJOR}/bin`,
    );
  }
  return dirs;
}

/** Absolute path of a PostgreSQL 17 tool (PG_BIN_DIR first, then PATH, then the usual install folders). */
export async function findPgTool(name) {
  const refused = [];
  for (const dir of candidateDirs()) {
    const file = join(dir, name + exe);
    if (!existsSync(file)) continue;
    const major = await toolMajor(file).catch(() => 0);
    if (major === REQUIRED_MAJOR) return file;
    refused.push(`${file} is version ${major || 'unknown'}`);
  }
  throw new Error(
    `${name} (PostgreSQL ${REQUIRED_MAJOR}) was not found. Install the PostgreSQL ${REQUIRED_MAJOR} client tools or set PG_BIN_DIR to their folder.${
      refused.length ? ` Found but refused: ${refused.join('; ')}.` : ''
    }`,
  );
}

export async function toolMajor(file) {
  const r = await run(file, ['--version']);
  const m = /(\d+)(?:\.\d+)?/.exec(r.stdout);
  return m ? Number(m[1]) : 0;
}

export function run(cmd, args, { env = {}, cwd, input, secrets = [], shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      cwd,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => reject(new Error(redact(err.message, secrets))));
    child.on('close', (code) =>
      resolve({ code, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets) }),
    );
    // a tool that exits before it reads its input (pg_dump --version) closes the pipe: that EPIPE is not an error of ours
    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') reject(err);
    });
    child.stdin.end(input ?? '');
  });
}

export async function runChecked(cmd, args, options = {}) {
  const r = await run(cmd, args, options);
  if (r.code !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-12).join('\n');
    throw new Error(
      `${cmd.split(/[\\/]/).pop()} failed (exit ${r.code})${tail ? `:\n${tail}` : ''}`,
    );
  }
  return r;
}

export function assertServerMajor(versionNum, what = 'the server') {
  const major = Math.floor(Number(versionNum) / 10_000);
  if (major !== REQUIRED_MAJOR)
    throw new Error(`${what} is PostgreSQL ${major}; only ${REQUIRED_MAJOR} is supported`);
}

// ------------------------------------------------------------------------------------------------ checksums
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export const sha256Text = (text) => createHash('sha256').update(text).digest('hex');

// ------------------------------------------------------------------------------------------------ what a database looks like
const quoteIdent = (n) => `"${String(n).replaceAll('"', '""')}"`;

// Each catalog digest is one query that returns one text line per object, ordered; the digest is the SHA-256 of the lines.
// The owner is deliberately left out (a restore with --no-owner makes the restoring user the owner); every other fact is in.
const ACL_OF = (aclColumn, kind, ownerColumn) => `coalesce((
  SELECT string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type || ':' || a.is_grantable, ',' ORDER BY coalesce(r.rolname, 'PUBLIC'), a.privilege_type)
    FROM aclexplode(coalesce(${aclColumn}, acldefault('${kind}', ${ownerColumn}))) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE a.grantee <> ${ownerColumn}), '')`;

const DIGEST_QUERIES = {
  tables: `SELECT c.relname || '|' || c.relkind::text || '|' || c.relpersistence::text || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || coalesce(array_to_string(c.reloptions, ','), '')
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'lms' AND c.relkind IN ('r', 'p', 'v') ORDER BY 1`,
  tableGrants: `SELECT c.relname || '|' || ${ACL_OF('c.relacl', 'r', 'c.relowner')}
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'lms' AND c.relkind IN ('r', 'p', 'v') ORDER BY 1`,
  columnGrants: `SELECT c.relname || '.' || a.attname || '|' || ${ACL_OF('a.attacl', 'c', 'c.relowner')}
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'lms' AND a.attacl IS NOT NULL AND NOT a.attisdropped ORDER BY 1`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || p.prosecdef || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || ${ACL_OF('p.proacl', 'f', 'p.proowner')}
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lms' ORDER BY 1`,
  policies: `SELECT tablename || '|' || policyname || '|' || cmd || '|' || permissive || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
             FROM pg_policies WHERE schemaname = 'lms' ORDER BY 1`,
  triggers: `SELECT c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid)
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'lms' AND NOT t.tgisinternal ORDER BY 1`,
  indexes: `SELECT tablename || '|' || indexdef FROM pg_indexes WHERE schemaname = 'lms' ORDER BY 1`,
  constraints: `SELECT c.relname || '|' || con.conname || '|' || con.contype::text || '|' || con.convalidated || '|' || pg_get_constraintdef(con.oid)
             FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'lms' ORDER BY 1`,
};

/**
 * Everything a restore must reproduce, read from ONE snapshot when the caller holds a REPEATABLE READ transaction:
 * the tables (persistence, row security enabled / forced), exact row counts of the logged tables, the migration bookkeeping and
 * a digest per kind of catalog object (grants, functions with their SET clauses and ACLs, policies, triggers, indexes, constraints).
 */
export async function collectState(client) {
  const tables = (
    await client.query(`SELECT c.relname AS name, c.relpersistence = 'u' AS unlogged, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'lms' AND c.relkind IN ('r', 'p') ORDER BY 1`)
  ).rows;
  const counts = {};
  for (const t of tables) {
    if (t.unlogged) continue;
    counts[t.name] = Number(
      (await client.query(`SELECT count(*) AS n FROM lms.${quoteIdent(t.name)}`)).rows[0].n,
    );
  }
  const migrationRows = (
    await client.query('SELECT filename, checksum FROM lms.schema_migrations')
  ).rows.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  const digests = {};
  for (const [name, sql] of Object.entries(DIGEST_QUERIES)) {
    // sorted HERE, by code unit: the SQL order of a text column follows the database's collation (en_US on CI's source, C on a scratch cluster)
    const lines = (await client.query(sql)).rows.map((r) => Object.values(r)[0]).sort();
    digests[name] = { count: lines.length, sha256: sha256Text(lines.join('\n')) };
  }
  return {
    tables,
    counts,
    migrations: {
      count: migrationRows.length,
      last: migrationRows.at(-1)?.filename ?? null,
      sha256: sha256Text(migrationRows.map((r) => `${r.filename}:${r.checksum}`).join('\n')),
    },
    digests,
  };
}

/** The migration runner's own bookkeeping: no tenant data, so no row-level security (the policy audit test lists the same two). */
export const BOOKKEEPING_TABLES = new Set(['schema_migrations', 'role_password_state']);
/** Emptied on purpose by every restore (the fingerprint belongs to the cluster the backup came from: see roles.mjs). */
export const CLEARED_BY_RESTORE = new Set(['role_password_state']);

/** What differs between the state recorded at backup time and the state of the restored database (empty = identical). */
export function compareState(expected, actual) {
  const failures = [];
  const names = (s) => s.tables.map((t) => t.name).join(',');
  if (names(expected) !== names(actual)) failures.push('the set of tables differs');
  for (const t of expected.tables) {
    const a = actual.tables.find((x) => x.name === t.name);
    if (!a) continue;
    if (a.unlogged !== t.unlogged) failures.push(`${t.name}: unlogged flag differs`);
    if (!BOOKKEEPING_TABLES.has(t.name) && (!a.rls || !a.forced))
      failures.push(`${t.name}: row-level security is not enabled AND forced`);
    if (
      !t.unlogged &&
      !CLEARED_BY_RESTORE.has(t.name) &&
      expected.counts[t.name] !== actual.counts[t.name]
    ) {
      failures.push(
        `${t.name}: ${actual.counts[t.name]} rows, the backup had ${expected.counts[t.name]}`,
      );
    }
  }
  if (expected.migrations.sha256 !== actual.migrations.sha256) {
    failures.push(
      `the applied migrations differ (${actual.migrations.count} now, ${expected.migrations.count} in the backup)`,
    );
  }
  for (const [kind, d] of Object.entries(expected.digests)) {
    const a = actual.digests[kind];
    if (!a || a.sha256 !== d.sha256)
      failures.push(`${kind} differ (${a?.count ?? 0} now, ${d.count} in the backup)`);
  }
  return failures;
}

/** An unlogged table is dumped without data (counters that a crash empties anyway): after a restore it must be empty. */
export async function unloggedAreEmpty(client, state) {
  const bad = [];
  for (const t of state.tables.filter((x) => x.unlogged)) {
    const n = Number(
      (await client.query(`SELECT count(*) AS n FROM lms.${quoteIdent(t.name)}`)).rows[0].n,
    );
    if (n !== 0) bad.push(`${t.name} is unlogged and holds ${n} rows after the restore`);
  }
  return bad;
}

export const timestampName = (d = new Date()) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
