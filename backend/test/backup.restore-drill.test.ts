import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reapplyErasures } from '../src/cli/privacy-reapply-erasures';
import { passwordFromUrl } from '../src/config/secrets';
import { runMigrations } from '../src/db/migrate';
import { makeApp, type TestApp, testEnv } from './app';
import { loginAs, ok, type Person, person } from './courses-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  getTestDatabases,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';
import {
  type Exec,
  exec,
  pgTool,
  type ScratchCluster,
  startScratchCluster,
} from './support/scratch-cluster';

// THE RESTORE DRILL (step 14b-2, part B). A backup is only a backup once somebody has restored it.
//
// The SOURCE is the worker's test database, filled with two colleges, people, a requested-and-approved erasure and a row in the unlogged
// rate-limit table. A backup is taken with the real script (scripts/backup/backup.mjs); THEN the erasure is carried out (so the backup is
// OLDER than the erasure, the situation the erasure ledger exists for). The backup is restored with the real scripts into a THROWAWAY SECOND
// CLUSTER (initdb, its own port, password authentication, no role of ours): the only situation that loses roles, role settings and the
// password. Every assertion reads the restored database itself (this file's own queries, not the scripts' verification), and the checks of
// the scripts are shown to have teeth by breaking the restored copy.
//
// Order matters (one story, top to bottom): backup -> erase -> damaged backups refused -> the dump ALONE into a bare cluster (the negative
// control: role settings lost, the password-fingerprint trap) -> a proper restore -> refusals -> restore + finish (roles, migrate, ledger).

// every step starts a process (the scripts, pnpm, a PostgreSQL server): far beyond the 10 s of an ordinary test
vi.setConfig({ testTimeout: 280_000, hookTimeout: 280_000 });

const ROOT = join(import.meta.dirname, '..', '..');
const script = (name: string) => join(ROOT, 'scripts', 'backup', name);
const KEYS = `k1:${'a'.repeat(40)}`;
const WRONG_CLUSTER_PASSWORD = 'a-different-password-on-the-new-cluster';

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin2: Person;
let X: Person; // asks for erasure; erased AFTER the backup
let Y: Person; // bystander in the same college
let Z: Person; // a member of the other college
let requestX: string;
let ledgerDir: string;
let work: string;
let cluster: ScratchCluster;
let sourceOwnerUrl: string;
let sourceAppUrl: string;
let appPassword: string;
// The NEW cluster's lms_app password in section 6: a new deployment has a password of its own (and the schema of db:migrate wants 24+
// characters, which CI's throwaway 23-character one is not)
const finishPassword = randomBytes(24).toString('base64url');
let backupDir: string;
let manifest: Manifest;
let before: Facts;
const transcript: string[] = []; // every byte the scripts printed: searched for secrets at the end

interface Manifest {
  files: Record<string, { bytes: number; sha256: string }>;
  state: {
    counts: Record<string, number>;
    tables: { name: string; unlogged: boolean }[];
    migrations: { count: number };
  };
  source: { database: string };
  rolePasswordsIncluded: boolean;
}

// ------------------------------------------------------------------------------------------------------------- running the scripts
const baseEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  DB_SSL: 'off',
  DB_SSL_CA: '',
  ...extra,
});

async function runScript(name: string, args: string[], env: Record<string, string>): Promise<Exec> {
  const r = await exec(process.execPath, [script(name), ...args], baseEnv(env), ROOT);
  transcript.push(r.stdout, r.stderr);
  return r;
}

const sourceEnv = () => ({
  DATABASE_URL: sourceOwnerUrl,
  DATABASE_APP_URL: sourceAppUrl,
  LMS_APP_PASSWORD: appPassword,
});
const restoreEnv = (database: string, extra: Record<string, string> = {}) => ({
  RESTORE_DATABASE_URL: cluster.ownerUrl(database),
  DATABASE_URL: '',
  DATABASE_APP_URL: '',
  ...extra,
});
const appEnv = () => ({
  LMS_APP_PASSWORD: finishPassword,
  ERASURE_LEDGER_DIR: ledgerDir,
  SUPPRESSION_HASH_KEYS: KEYS,
});
const rolesEnv = (database: string) => ({
  DATABASE_URL: cluster.ownerUrl(database),
  DATABASE_APP_URL: cluster.urlFor('lms_app', appPassword, database),
  LMS_APP_PASSWORD: appPassword,
});

async function clusterClient(database: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: cluster.ownerUrl(database) });
  await c.connect();
  return c;
}

async function clusterQuery<R extends pg.QueryResultRow = Record<string, unknown>>(
  database: string,
  sql: string,
  params: unknown[] = [],
) {
  const c = await clusterClient(database);
  try {
    return (await c.query<R>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return (
    (await clusterQuery('postgres', 'SELECT 1 FROM pg_database WHERE datname = $1', [name]))
      .length > 0
  );
}

const quote = (n: string) => `"${n.replaceAll('"', '""')}"`;

// ------------------------------------------------------------------------------------------------------------- what a database holds
interface Facts {
  tables: string[];
  unlogged: string[];
  counts: Record<string, number>;
  rls: { name: string; enabled: boolean; forced: boolean }[];
  policies: unknown[];
  functions: unknown[];
  triggers: unknown[];
  privileges: unknown[];
  fkCount: number;
  migrations: unknown[];
}

/** Independent of the scripts: this file's own reading of a database. */
async function facts(c: Pick<pg.Pool, 'query'>): Promise<Facts> {
  const tables = (
    await c.query<{ relname: string; persistence: string; enabled: boolean; forced: boolean }>(
      `SELECT c.relname, c.relpersistence AS persistence, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'lms' AND c.relkind = 'r' ORDER BY 1`,
    )
  ).rows;
  const counts: Record<string, number> = {};
  for (const tb of tables) {
    if (tb.persistence === 'u') continue;
    counts[tb.relname] = Number(
      (await c.query(`SELECT count(*) AS n FROM lms.${quote(tb.relname)}`)).rows[0].n,
    );
  }
  const q = async (sql: string) => (await c.query(sql)).rows;
  return {
    tables: tables.map((x) => x.relname),
    unlogged: tables.filter((x) => x.persistence === 'u').map((x) => x.relname),
    counts,
    rls: tables.map((x) => ({ name: x.relname, enabled: x.enabled, forced: x.forced })),
    policies: await q(
      `SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM pg_policies WHERE schemaname = 'lms' ORDER BY 1, 2`,
    ),
    functions: await q(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.provolatile, p.proconfig,
              has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lms' ORDER BY p.oid::regprocedure::text COLLATE "C"`,
    ),
    triggers: await q(
      `SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'lms' AND NOT t.tgisinternal ORDER BY 1, 2`,
    ),
    privileges: await q(
      `SELECT c.relname,
              has_table_privilege('lms_app', c.oid, 'SELECT') AS s, has_table_privilege('lms_app', c.oid, 'INSERT') AS i,
              has_table_privilege('lms_app', c.oid, 'UPDATE') AS u, has_table_privilege('lms_app', c.oid, 'DELETE') AS d,
              has_table_privilege('public', c.oid, 'SELECT') AS ps
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'lms' AND c.relkind IN ('r', 'v') ORDER BY 1`,
    ),
    fkCount: Number(
      (
        await c.query(
          "SELECT count(*) AS n FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE con.contype = 'f' AND n.nspname = 'lms'",
        )
      ).rows[0].n,
    ),
    migrations: await q(
      'SELECT filename, checksum FROM lms.schema_migrations ORDER BY filename COLLATE "C"',
    ),
  };
}

/** Rows whose foreign key points at nothing (every foreign key of schema lms, composite ones included). */
async function orphans(c: Pick<pg.Pool, 'query'>): Promise<string[]> {
  const fks = (
    await c.query<{
      conname: string;
      child: string;
      parent: string;
      ccols: string[];
      pcols: string[];
    }>(
      `SELECT con.conname, c.relname AS child, p.relname AS parent,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS ccols,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS pcols
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'lms' ORDER BY 1`,
    )
  ).rows;
  const bad: string[] = [];
  for (const fk of fks) {
    const allSet = fk.ccols.map((col) => `c.${quote(col)} IS NOT NULL`).join(' AND ');
    const same = fk.ccols
      .map((col, i) => `p.${quote(fk.pcols[i] as string)} = c.${quote(col)}`)
      .join(' AND ');
    const n = Number(
      (
        await c.query(
          `SELECT count(*) AS n FROM lms.${quote(fk.child)} c WHERE ${allSet} AND NOT EXISTS (SELECT 1 FROM lms.${quote(fk.parent)} p WHERE ${same})`,
        )
      ).rows[0].n,
    );
    if (n > 0) bad.push(`${fk.conname}: ${n} orphan rows in ${fk.child}`);
  }
  return bad;
}

/** A sign-in of lms_app on the restored cluster; rejects when the password is not accepted. */
async function appClient(database: string, password = appPassword): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: cluster.urlFor('lms_app', password, database) });
  await c.connect();
  return c;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------------------------- setup
beforeAll(async () => {
  const dbs = getTestDatabases();
  sourceOwnerUrl = dbs.ownerUrl;
  sourceAppUrl = dbs.appUrl;
  appPassword = passwordFromUrl(dbs.appUrl);
  work = await mkdtemp(join(tmpdir(), 'lms-drill-'));
  ledgerDir = await mkdtemp(join(tmpdir(), 'lms-drill-ledger-'));
  owner = testOwnerPool(6);
  // fail LOUDLY when the PostgreSQL 17 tools are missing (a skipped drill is a drill nobody ran)
  for (const tool of ['pg_dump', 'pg_dumpall', 'pg_restore', 'initdb', 'pg_ctl'])
    await pgTool(tool);
  cluster = await startScratchCluster();

  t = makeApp({
    env: {
      RATE_LIMIT_MAX: '1000000',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      LOGIN_MAX_ATTEMPTS: '50',
      DATA_EXPORT_RATE_PER_HOUR: '100000',
      TENANT_CACHE_TTL_MS: '3600000',
      ERASURE_LEDGER_DIR: ledgerDir,
      SUPPRESSION_HASH_KEYS: KEYS,
    },
  });
  A = await createAuthFixture(owner, 'drill-a');
  B = await createAuthFixture(owner, 'drill-b');
  await t.app.ready();
  await loginAs(t, A.host, A.adminEmail);
  admin2 = await person(owner, t, A, 'Drill Admin Two', { role: 'institution_admin' });
  X = await person(owner, t, A, 'Drill Erased Person');
  Y = await person(owner, t, A, 'Drill Bystander');
  Z = await person(owner, t, B, 'Drill Other College');
  const asked = ok(await X.client.post('/me/erasure', { password: TEST_PASSWORD }));
  requestX = asked.request.id as string;
  ok(await admin2.client.post(`/privacy/erasure-requests/${requestX}/approve`, {}));
  await owner.query("SELECT lms.rate_limit_hit('drill:key', 600000, 3)"); // a row in the UNLOGGED table: the dump must leave it out
}, 240_000);

afterAll(async () => {
  await t?.close();
  await owner?.end();
  await cluster?.stop();
  if (work) await rm(work, { recursive: true, force: true });
  if (ledgerDir) await rm(ledgerDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------------------- the story
describe('1. the backup', () => {
  it('writes a folder with the dump, the globals, a manifest and checksums that agree with the files, in one piece', async () => {
    before = await facts(owner);
    expect(before.unlogged).toContain('rate_limit_counters');
    expect(
      Number((await owner.query('SELECT count(*) AS n FROM lms.rate_limit_counters')).rows[0].n),
    ).toBeGreaterThan(0);

    const out = join(work, 'backups');
    const r = await runScript('backup.mjs', ['--out', out], sourceEnv());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/backup complete: .*lms-lms_test_\d+-\d{8}T\d{6}Z/);
    const folders = await readdir(out);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^lms-[a-z0-9_]+-\d{8}T\d{6}Z$/); // no ".partial" left behind
    backupDir = join(out, folders[0] as string);
    expect((await readdir(backupDir)).sort()).toEqual([
      'SHA256SUMS',
      'database.dump',
      'globals.sql',
      'manifest.json',
    ]);

    manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
    for (const [f, v] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(backupDir, f));
      expect(v.bytes).toBe(bytes.length);
      expect(v.sha256).toBe(sha(bytes));
    }
    // SHA256SUMS is `sha256sum -c` compatible and agrees with the manifest
    const sums = (await readFile(join(backupDir, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    expect(sums.sort()).toEqual(
      Object.entries(manifest.files)
        .map(([f, v]) => `${v.sha256}  ${f}`)
        .sort(),
    );
    // the manifest holds the exact counts of the SAME snapshot as the dump
    expect(manifest.state.counts).toEqual(before.counts);
    expect(manifest.state.migrations.count).toBe(before.migrations.length);
    expect(manifest.state.tables.find((x) => x.name === 'rate_limit_counters')?.unlogged).toBe(
      true,
    );
    expect(manifest.rolePasswordsIncluded).toBe(false);
  }, 120_000);

  it('the globals file carries the role defaults (what a dump alone loses) and NO password hash', async () => {
    const globals = await readFile(join(backupDir, 'globals.sql'), 'utf8');
    expect(globals).toMatch(/^ALTER ROLE lms_app SET "TimeZone" TO 'UTC';$/m);
    expect(globals).toMatch(/^ALTER ROLE lms_app SET jit TO 'off';$/m);
    expect(globals).not.toMatch(/PASSWORD\s+'/i);
    expect(globals).not.toContain('SCRAM-SHA-256');
  });

  it('a failed backup leaves no folder behind and never prints the password', async () => {
    const u = new URL(sourceOwnerUrl);
    u.password = 'wrong-password-xyz';
    const out = join(work, 'failed-backups');
    const r = await runScript('backup.mjs', ['--out', out], { DATABASE_URL: u.toString() });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).not.toContain('wrong-password-xyz');
    expect((await readdir(out).catch(() => [])).filter((f) => f.startsWith('lms-'))).toEqual([]);
  }, 60_000);
});

describe('2. the erasure happens AFTER the backup', () => {
  it('carries out the approved erasure of X in the live database and writes the ledger', async () => {
    await owner.query(
      "UPDATE lms.erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
      [requestX],
    );
    expect((await t.app.modules.privacy.erasureService.scan()).erased).toBeGreaterThanOrEqual(1);
    const status = (
      await owner.query('SELECT status FROM lms.erasure_requests WHERE id = $1', [requestX])
    ).rows[0].status;
    expect(status).toBe('done');
    expect(
      (
        await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [
          X.membershipId,
        ])
      ).rows[0].status,
    ).toBe('removed');
    expect(await readFile(join(ledgerDir, 'erasure-ledger.jsonl'), 'utf8')).toContain(X.userId);
  }, 60_000);
});

describe('3. damaged backups are refused before anything is touched', () => {
  it('a flipped byte (SHA-256) and a truncated dump (size) are refused, and the target database is not even created', async () => {
    const flipped = join(work, 'flipped');
    await cp(backupDir, flipped, { recursive: true });
    const dump = await readFile(join(flipped, 'database.dump'));
    dump[Math.floor(dump.length / 2)] = (dump[Math.floor(dump.length / 2)] ?? 0) ^ 0xff;
    await writeFile(join(flipped, 'database.dump'), dump);
    const r1 = await runScript('restore.mjs', ['--backup', flipped], restoreEnv('drill_flipped'));
    expect(r1.code).toBe(3);
    expect(r1.stderr).toMatch(/SHA-256 differs/);
    expect(await databaseExists('drill_flipped')).toBe(false);

    const cut = join(work, 'cut');
    await cp(backupDir, cut, { recursive: true });
    const whole = await readFile(join(cut, 'database.dump'));
    await writeFile(join(cut, 'database.dump'), whole.subarray(0, whole.length - 10));
    const r2 = await runScript('restore.mjs', ['--backup', cut], restoreEnv('drill_cut'));
    expect(r2.code).toBe(3);
    expect(r2.stderr).toMatch(/size differs/);
    expect(await databaseExists('drill_cut')).toBe(false);

    const noManifest = join(work, 'nomanifest');
    await cp(backupDir, noManifest, { recursive: true });
    await rm(join(noManifest, 'manifest.json'));
    const r3 = await runScript(
      'restore.mjs',
      ['--backup', noManifest],
      restoreEnv('drill_nomanifest'),
    );
    expect(r3.code).not.toBe(0);
    expect(await databaseExists('drill_nomanifest')).toBe(false);
  }, 120_000);
});

describe('4. NEGATIVE CONTROL: the dump ALONE, restored into a cluster that was set up by hand', () => {
  const db = 'drill_raw';

  it('restores, but the role defaults are gone and the password fingerprint is a TRAP', async () => {
    const adm = await clusterClient('postgres');
    try {
      // what an operator does by hand on a new cluster (CI does the same): the roles, a password of the NEW cluster, nothing else
      await adm.query('CREATE ROLE anon NOLOGIN');
      await adm.query('CREATE ROLE authenticated NOLOGIN');
      await adm.query(
        `CREATE ROLE lms_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${WRONG_CLUSTER_PASSWORD}'`,
      );
      await adm.query(`CREATE DATABASE ${db}`);
    } finally {
      await adm.end();
    }
    const pgRestore = await pgTool('pg_restore');
    const u = new URL(cluster.ownerUrl(db));
    const r = await exec(
      pgRestore,
      [
        '--no-owner',
        '--exit-on-error',
        '--single-transaction',
        '--dbname',
        db,
        join(backupDir, 'database.dump'),
      ],
      {
        PGHOST: u.hostname,
        PGPORT: u.port,
        PGUSER: 'postgres',
        PGPASSWORD: cluster.superPassword,
      },
    );
    expect(r.code, r.stderr).toBe(0);

    // (1) the dump does NOT carry the role's defaults: this is why globals.sql and db:verify-roles exist
    const settings = await clusterQuery(
      'postgres',
      "SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'lms_app'",
    );
    expect(settings).toHaveLength(0);
    // (2) it DOES carry the fingerprint of the SOURCE cluster's password
    const stored = await clusterQuery<{ fingerprint: string }>(
      db,
      "SELECT fingerprint FROM lms.role_password_state WHERE role_name = 'lms_app'",
    );
    expect(stored[0]?.fingerprint).toBe(sha(`lms_app:${appPassword}`));
    // (3) so db:migrate believes the password is already set, and leaves the new cluster's password alone
    const migrated = await runMigrations({
      ownerUrl: cluster.ownerUrl(db),
      ssl: 'off',
      appPassword,
    });
    expect(migrated.applied).toEqual([]);
    expect(migrated.passwordChanged).toBe(false);
    // (4) ... and the application cannot sign in, with nothing pointing at the cause
    await expect(appClient(db)).rejects.toMatchObject({ code: '28P01' });
  }, 120_000);

  it('db:verify-roles names the trap and the missing defaults, exits 1; --fix repairs them, a real sign-in works, and the output has no password', async () => {
    const r = await runScript('verify-roles.mjs', [], rolesEnv(db));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL .*cannot sign in/);
    expect(r.stdout).toMatch(/FAIL .*FINGERPRINT SAYS/);
    expect(r.stdout).toMatch(/FAIL .*no timezone default/);
    expect(r.stdout).toMatch(/FAIL .*no jit default/);

    const fixed = await runScript('verify-roles.mjs', ['--fix'], rolesEnv(db));
    expect(fixed.code, fixed.stdout + fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain('roles: repaired and verified');
    const c = await appClient(db);
    try {
      const me = (
        await c.query(
          "SELECT current_user AS u, current_setting('timezone') AS tz, current_setting('jit') AS jit, current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS idle",
        )
      ).rows[0];
      expect(me).toEqual({ u: 'lms_app', tz: 'UTC', jit: 'off', st: '30s', idle: '30s' });
    } finally {
      await c.end();
    }
    const again = await runScript('verify-roles.mjs', [], rolesEnv(db));
    expect(again.code, again.stdout).toBe(0);
  }, 120_000);

  it('cleans up: the database and the roles go, so the next restore meets a cluster with none of ours', async () => {
    await clusterQuery('postgres', `DROP DATABASE ${db} WITH (FORCE)`);
    for (const role of ['lms_app', 'anon', 'authenticated'])
      await clusterQuery('postgres', `DROP ROLE ${role}`);
    expect(
      await clusterQuery(
        'postgres',
        "SELECT 1 FROM pg_roles WHERE rolname IN ('lms_app', 'anon', 'authenticated')",
      ),
    ).toHaveLength(0);
  }, 60_000);
});

describe('5. a proper restore into the bare cluster (roles from the globals file), checked by this file independently', () => {
  const db = 'drill_main';

  it('verifies the checksums, creates the roles, applies the defaults of globals.sql, restores in one transaction and clears the fingerprint', async () => {
    const r = await runScript('restore.mjs', ['--backup', backupDir, '--globals'], restoreEnv(db));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/backup verified: 2 files match the manifest/);
    expect(r.stdout).toMatch(
      /globals\.sql: [1-9]\d* ALTER ROLE statement\(s\) for our roles applied/,
    );
    expect(r.stdout).toContain('fingerprint was cleared');
    expect(r.stdout).toContain('restored state matches the manifest');
    expect(r.stdout).toContain('NOT finished');
  }, 180_000);

  it('the dump did not bring the application back to life by itself: the globals gave the defaults, but lms_app has no password yet', async () => {
    const settings = await clusterQuery<{ setconfig: string[] }>(
      'postgres',
      "SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'lms_app' AND s.setdatabase = 0",
    );
    expect(settings[0]?.setconfig).toEqual(
      expect.arrayContaining(['TimeZone=UTC', 'jit=off', 'statement_timeout=30s']),
    );
    await expect(appClient(db)).rejects.toBeDefined();
    expect(
      await clusterQuery(db, "SELECT 1 FROM lms.role_password_state WHERE role_name = 'lms_app'"),
    ).toHaveLength(0);
  });

  it('every table has the rows it had, as counted by this file (also equal to the manifest); the unlogged table is EMPTY but still unlogged', async () => {
    const c = await clusterClient(db);
    try {
      const after = await facts(c);
      expect(after.tables).toEqual(before.tables);
      // role_password_state is emptied on purpose by the restore (the fingerprint of the source cluster's password); checked on its own below
      const { role_password_state: _a, ...afterCounts } = after.counts;
      const { role_password_state: _b, ...beforeCounts } = before.counts;
      const { role_password_state: _c, ...manifestCounts } = manifest.state.counts;
      expect(afterCounts).toEqual(beforeCounts);
      expect(afterCounts).toEqual(manifestCounts);
      expect(after.counts.role_password_state).toBe(0);
      expect(Object.keys(after.counts).length).toBeGreaterThan(30);
      expect(after.unlogged).toEqual(before.unlogged);
      expect(
        Number((await c.query('SELECT count(*) AS n FROM lms.rate_limit_counters')).rows[0].n),
      ).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('row-level security is still enabled AND forced on every table, with the same policies, triggers, functions (SET clauses, ACLs) and grants', async () => {
    const c = await clusterClient(db);
    try {
      const after = await facts(c);
      expect(after.rls).toEqual(before.rls);
      // every table of tenant data; the migration runner's two bookkeeping tables never had it
      for (const x of after.rls.filter(
        (r) => !['schema_migrations', 'role_password_state'].includes(r.name),
      )) {
        expect(x, `${x.name} lost row-level security`).toMatchObject({
          enabled: true,
          forced: true,
        });
      }
      expect(after.policies).toEqual(before.policies);
      expect(after.policies.length).toBeGreaterThan(30);
      expect(after.triggers).toEqual(before.triggers);
      expect(after.functions).toEqual(before.functions);
      expect(after.privileges).toEqual(before.privileges);
      // the SECURITY DEFINER functions kept their search_path (a restore that drops it would be a privilege escalation)
      const definers = (
        after.functions as { prosecdef: boolean; proconfig: string[] | null }[]
      ).filter((f) => f.prosecdef);
      expect(definers.length).toBeGreaterThan(50);
      for (const f of definers)
        expect(f.proconfig?.some((s) => s.startsWith('search_path='))).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('migrations: the same files with the same checksums; foreign keys all present and validated, and no row points at nothing', async () => {
    const c = await clusterClient(db);
    try {
      const after = await facts(c);
      expect(after.migrations).toEqual(before.migrations);
      expect(after.fkCount).toBe(before.fkCount);
      expect(after.fkCount).toBeGreaterThan(50);
      expect(
        Number(
          (await c.query('SELECT count(*) AS n FROM pg_constraint WHERE NOT convalidated')).rows[0]
            .n,
        ),
      ).toBe(0);
      expect(await orphans(c)).toEqual([]);
    } finally {
      await c.end();
    }
    // the application's own runner agrees: nothing to apply, no checksum complaint
    const m = await runMigrations({ ownerUrl: cluster.ownerUrl(db), ssl: 'off', appPassword });
    expect(m.applied).toEqual([]);
    expect(m.skipped).toHaveLength(before.migrations.length);
  }, 60_000);

  it('the restore is the state of the BACKUP: X is still there with the real name (the older backup brings a person back), and nothing is erased yet', async () => {
    const c = await clusterClient(db);
    try {
      const x = (
        await c.query(
          'SELECT display_name, email, erased FROM lms.member_identity WHERE membership_id = $1',
          [X.membershipId],
        )
      ).rows[0];
      expect(x).toMatchObject({ display_name: 'Drill Erased Person', erased: false });
      expect(x.email).toBe(X.email.toLowerCase());
      expect(
        (await c.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [X.membershipId]))
          .rows[0].status,
      ).toBe('active');
      expect(
        (await c.query('SELECT status FROM lms.erasure_requests WHERE id = $1', [requestX])).rows[0]
          .status,
      ).toBe('approved');
      expect(
        (await c.query('SELECT count(*)::int AS n FROM lms.membership_display_overrides')).rows[0]
          .n,
      ).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('db:verify-restore agrees, and HAS TEETH: forcing row-level security off, or changing a function, makes it exit 5', async () => {
    const ok1 = await runScript('verify-restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(ok1.code, ok1.stderr).toBe(0);

    await clusterQuery(db, 'ALTER TABLE lms.audit_log NO FORCE ROW LEVEL SECURITY');
    const r1 = await runScript('verify-restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(r1.code).toBe(5);
    expect(r1.stderr).toMatch(/audit_log: row-level security is not enabled AND forced/);
    expect(r1.stderr).toMatch(/tables differ/);
    await clusterQuery(db, 'ALTER TABLE lms.audit_log FORCE ROW LEVEL SECURITY');

    await clusterQuery(
      db,
      "ALTER FUNCTION lms.rate_limit_hit(text, integer, integer) SET work_mem = '1MB'",
    );
    const r2 = await runScript('verify-restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(r2.code).toBe(5);
    expect(r2.stderr).toMatch(/functions differ/);
    await clusterQuery(
      db,
      'ALTER FUNCTION lms.rate_limit_hit(text, integer, integer) RESET work_mem',
    );

    // an unlogged table that holds rows after a restore, and a missing row
    await clusterQuery(db, "SELECT lms.rate_limit_hit('tamper', 60000, 1)");
    const r3 = await runScript('verify-restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(r3.code).toBe(5);
    expect(r3.stderr).toMatch(/rate_limit_counters is unlogged and holds 1 rows after the restore/);
    await clusterQuery(db, 'DELETE FROM lms.rate_limit_counters');
    const ok2 = await runScript('verify-restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(ok2.code, ok2.stderr).toBe(0);

    await clusterQuery(
      db,
      'DELETE FROM lms.sessions WHERE id = (SELECT id FROM lms.sessions LIMIT 1)',
    );
    const r4 = await runScript('verify-restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(r4.code).toBe(5);
    expect(r4.stderr).toMatch(/sessions: \d+ rows, the backup had \d+/);
    // (this copy is damaged on purpose: the next step restores over it)
  }, 180_000);

  it('refuses to restore over a database that holds the application unless told so twice (--replace and the typed name)', async () => {
    const plain = await runScript('restore.mjs', ['--backup', backupDir], restoreEnv(db));
    expect(plain.code).toBe(1);
    expect(plain.stderr).toMatch(/already holds \d+ tables .*--replace --confirm drill_main/);
    const wrong = await runScript(
      'restore.mjs',
      ['--backup', backupDir, '--replace', '--confirm', 'something_else'],
      restoreEnv(db),
    );
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/--confirm drill_main/);
    expect((await clusterQuery(db, 'SELECT count(*)::int AS n FROM lms.users'))[0]).toMatchObject({
      n: before.counts.users,
    });
  }, 120_000);
});

describe('6. restore + finish: roles repaired, migrated, and the ERASURE LEDGER applied again', () => {
  const db = 'drill_main';
  let finish: Exec;

  it('one command restores over the previous copy (--replace --confirm) and finishes; X is erased again', async () => {
    finish = await runScript(
      'restore.mjs',
      ['--backup', backupDir, '--replace', '--confirm', db, '--finish'],
      restoreEnv(db, appEnv()),
    );
    expect(finish.code, finish.stdout + finish.stderr).toBe(0);
    expect(finish.stdout).toMatch(/dropping database drill_main \(--replace\)/);
    expect(finish.stdout).toMatch(/ok .*lms_app signs in/);
    expect(finish.stdout).toMatch(/erasure ledger: \d+ entr(?:y|ies); erased again [1-9]/);
    expect(finish.stdout).toContain('restore finished');
  }, 280_000);

  it('X is erased in the restored database exactly as in the live one; the bystander and the other college are untouched', async () => {
    const c = await clusterClient(db);
    try {
      const x = (
        await c.query(
          'SELECT display_name, email, erased FROM lms.member_identity WHERE membership_id = $1',
          [X.membershipId],
        )
      ).rows[0];
      expect(x.erased).toBe(true);
      expect(x.email).toBe('');
      expect(x.display_name).not.toContain('Drill Erased');
      expect(
        (await c.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [X.membershipId]))
          .rows[0].status,
      ).toBe('removed');
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
            [X.membershipId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS n FROM lms.sessions WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL',
            [X.userId, A.tenantId],
          )
        ).rows[0].n,
      ).toBe(0);
      const live = (
        await owner.query('SELECT erased FROM lms.member_identity WHERE membership_id = $1', [
          X.membershipId,
        ])
      ).rows[0];
      expect(live.erased).toBe(true);
      for (const p of [Y, Z]) {
        const row = (
          await c.query('SELECT erased FROM lms.member_identity WHERE membership_id = $1', [
            p.membershipId,
          ])
        ).rows[0];
        expect(row.erased).toBe(false);
        expect(
          (
            await c.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [
              p.membershipId,
            ])
          ).rows[0].status,
        ).toBe('active');
      }
      expect(
        (
          await c.query('SELECT display_name FROM lms.member_identity WHERE membership_id = $1', [
            Y.membershipId,
          ])
        ).rows[0].display_name,
      ).toBe('Drill Bystander');
      expect(await orphans(c)).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it('the application role signs in with the password of the environment and row-level security works in the restored database', async () => {
    const c = await appClient(db, finishPassword);
    try {
      expect(
        (await c.query("SELECT current_setting('timezone') AS tz, current_setting('jit') AS jit"))
          .rows[0],
      ).toEqual({ tz: 'UTC', jit: 'off' });
      // no tenant: every tenant table is empty
      expect(
        (await c.query('SELECT count(*)::int AS n FROM lms.tenant_memberships')).rows[0].n,
      ).toBe(0);
      // tenant A: A's people, none of B's
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenantId]);
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE tenant_id = $1',
            [A.tenantId],
          )
        ).rows[0].n,
      ).toBeGreaterThan(3);
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE tenant_id = $1',
            [B.tenantId],
          )
        ).rows[0].n,
      ).toBe(0);
      // the audit log is append-only for the application, also after a restore
      await expect(c.query("UPDATE lms.audit_log SET action = 'tampered'")).rejects.toBeDefined();
      await c.query('ROLLBACK');
      // a SECURITY DEFINER function answers (the grants and the search_path survived)
      const lookup = await c.query('SELECT * FROM lms.auth_lookup_session($1, NULL, 300, 604800)', [
        randomBytes(32),
      ]);
      expect(lookup.rowCount).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('the repair set the password and its fingerprint (the migration runner now has nothing to do), and running the ledger again changes nothing more', async () => {
    const m = await runMigrations({
      ownerUrl: cluster.ownerUrl(db),
      ssl: 'off',
      appPassword: finishPassword,
    });
    expect(m.applied).toEqual([]);
    expect(m.passwordChanged).toBe(false);
    const env = testEnv({
      DATABASE_APP_URL: cluster.urlFor('lms_app', finishPassword, db),
      DB_SSL: 'off',
      ERASURE_LEDGER_DIR: ledgerDir,
      SUPPRESSION_HASH_KEYS: KEYS,
    });
    const second = await reapplyErasures(env);
    expect(second.reapplied).toBe(0);
    expect(second.already).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('7. hygiene', () => {
  it('no password of any of the three databases appears in anything the scripts printed or wrote', async () => {
    const secrets = [
      cluster.superPassword,
      WRONG_CLUSTER_PASSWORD,
      appPassword,
      finishPassword,
      passwordFromUrl(sourceOwnerUrl),
    ];
    const written = [
      await readFile(join(backupDir, 'manifest.json'), 'utf8'),
      await readFile(join(backupDir, 'SHA256SUMS'), 'utf8'),
      await readFile(join(backupDir, 'globals.sql'), 'utf8'),
    ];
    const everything = [...transcript, ...written].join('\n');
    expect(everything.length).toBeGreaterThan(1000);
    for (const s of secrets) {
      if (s.length < 4) continue;
      // A short or common password (CI's superuser password is "postgres", also a user and a database name) cannot be searched as a bare
      // word: it is looked for where a password would be, in a URL (":pw@") or in PGPASSWORD. A long random one is searched anywhere.
      if (s.length < 12) {
        expect(everything.includes(`:${s}@`), 'a password appeared in a URL').toBe(false);
        expect(everything.includes(`PGPASSWORD=${s}`)).toBe(false);
        continue;
      }
      expect(everything.includes(s), 'a password appeared in the output of the scripts').toBe(
        false,
      );
      expect(everything.includes(encodeURIComponent(s))).toBe(false);
    }
    expect((await stat(join(backupDir, 'database.dump'))).size).toBeGreaterThan(10_000);
  });
});
