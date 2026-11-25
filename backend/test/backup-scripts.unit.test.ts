import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The backup scripts (scripts/backup/*.mjs) without a database: the role specification stays equal to the migrations, only OUR roles are
// ever touched when a globals file is applied, retention pruning deletes only what it should, secrets are redacted, and the comparison of
// two database states notices every kind of difference. The restore drill (backup.restore-drill.test.ts) runs the real thing.

const ROOT = join(import.meta.dirname, '..', '..');
const load = async <T>(file: string) =>
  (await import(pathToFileURL(join(ROOT, 'scripts', 'backup', file)).href)) as T;

interface Roles {
  APP_ROLE: string;
  COMPAT_ROLES: string[];
  APP_ROLE_ATTRIBUTES: Record<string, boolean>;
  APP_ROLE_SETTINGS: Record<string, string>;
  passwordFingerprint(password: string): string;
  applyOurGlobals(client: { query(sql: string): Promise<unknown> }, sql: string): Promise<number>;
}
interface Lib {
  redact(text: string, secrets: string[]): string;
  parseDbUrl(url: string): {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  sslMode(host: string): string;
  compareState(expected: State, actual: State): string[];
  timestampName(d: Date): string;
}
interface Backup {
  pruneBackups(dir: string, keepDays: number, now: number): Promise<string[]>;
}
interface State {
  tables: { name: string; unlogged: boolean; rls: boolean; forced: boolean }[];
  counts: Record<string, number>;
  migrations: { count: number; last: string | null; sha256: string };
  digests: Record<string, { count: number; sha256: string }>;
}

const migrationsDir = join(ROOT, 'backend', 'migrations');

describe('the role specification', () => {
  it('equals what the migrations do to lms_app (attributes and every ALTER ROLE ... SET)', async () => {
    const roles = await load<Roles>('roles.mjs');
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const settings: Record<string, string> = {};
    let create = '';
    for (const f of files) {
      const text = await readFile(join(migrationsDir, f), 'utf8');
      for (const m of text.matchAll(/^ALTER ROLE lms_app SET (\w+) = ('[^']*'|\w+);/gm)) {
        settings[m[1] as string] = (m[2] as string).replaceAll("'", '');
      }
      const c = /CREATE ROLE lms_app ([A-Z ]+);/.exec(text);
      if (c) create = c[1] as string;
    }
    expect(settings).toEqual(roles.APP_ROLE_SETTINGS);
    const attrs: Record<string, boolean> = {
      rolcanlogin: create.includes('LOGIN') && !create.includes('NOLOGIN'),
      rolsuper: !create.includes('NOSUPERUSER'),
      rolbypassrls: !create.includes('NOBYPASSRLS'),
      rolcreatedb: !create.includes('NOCREATEDB'),
      rolcreaterole: !create.includes('NOCREATEROLE'),
      rolreplication: !create.includes('NOREPLICATION'),
    };
    expect(attrs).toEqual(roles.APP_ROLE_ATTRIBUTES);
  });

  it('uses the fingerprint formula of the migration runner (a different one would make the trap check lie)', async () => {
    const roles = await load<Roles>('roles.mjs');
    expect(roles.passwordFingerprint('pw-123456')).toBe(
      createHash('sha256').update('lms_app:pw-123456').digest('hex'),
    );
    expect(await readFile(join(ROOT, 'backend', 'src', 'db', 'migrate.ts'), 'utf8')).toMatch(
      /sha256\(`lms_app:\$\{opts\.appPassword\}`\)/,
    );
  });
});

describe('applying a globals file', () => {
  it('applies only ALTER ROLE statements of our roles: no CREATE ROLE, no GRANT, no other role, no password, no database-specific setting', async () => {
    const roles = await load<Roles>('roles.mjs');
    const applied: string[] = [];
    const client = {
      query: async (sql: string) => {
        applied.push(sql);
        return {};
      },
    };
    const globals = [
      '--',
      'CREATE ROLE lms_app;',
      "ALTER ROLE lms_app WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:abc';",
      'ALTER ROLE lms_app WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;',
      "ALTER ROLE lms_app SET timezone TO 'UTC';",
      'ALTER ROLE lms_app SET jit TO off;',
      "ALTER ROLE lms_app IN DATABASE lms_test_1 SET search_path TO 'x';",
      "ALTER ROLE postgres WITH SUPERUSER PASSWORD 'x';",
      'ALTER ROLE postgres SET jit TO on;',
      'ALTER ROLE anon WITH NOLOGIN;',
      'GRANT pg_read_all_data TO lms_app GRANTED BY postgres;',
      'DROP ROLE anon;',
      'ALTER ROLE lms_app_evil SET jit TO on;',
    ].join('\n');
    expect(await roles.applyOurGlobals(client, globals)).toBe(4);
    expect(applied).toEqual([
      'ALTER ROLE lms_app WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;',
      "ALTER ROLE lms_app SET timezone TO 'UTC';",
      'ALTER ROLE lms_app SET jit TO off;',
      'ALTER ROLE anon WITH NOLOGIN;',
    ]);
  });
});

describe('retention pruning', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lms-prune-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes complete backups older than the window and nothing else', async () => {
    const backup = await load<Backup>('backup.mjs');
    const now = Date.parse('2026-12-31T12:00:00Z');
    const make = async (name: string, withManifest: boolean) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, withManifest ? 'manifest.json' : 'note.txt'), '{}');
    };
    await make('lms-lms_prod-20261130T120000Z', true); // 31 days old: removed
    await make('lms-lms_prod-20261201T120000Z', true); // 30 days old exactly: kept
    await make('lms-lms_prod-20261230T120000Z', true); // yesterday: kept
    await make('lms-lms_prod-20260101T000000Z', false); // old but no manifest (not complete, not ours to judge): kept
    await make('my-own-folder-20200101T000000Z', true); // not our naming: kept
    await make('lms-lms_prod-20200101T000000Z.partial', true); // an unfinished backup is not matched by the pattern: kept
    const removed = await backup.pruneBackups(dir, 30, now);
    expect(removed).toEqual(['lms-lms_prod-20261130T120000Z']);
    expect((await readdir(dir)).sort()).toEqual([
      'lms-lms_prod-20200101T000000Z.partial',
      'lms-lms_prod-20260101T000000Z',
      'lms-lms_prod-20261201T120000Z',
      'lms-lms_prod-20261230T120000Z',
      'my-own-folder-20200101T000000Z',
    ]);
  });
});

describe('secrets and connections', () => {
  it('redacts a password in plain and URL-encoded form and ignores a too-short value', async () => {
    const lib = await load<Lib>('lib.mjs');
    expect(lib.redact('error for pw/ab12 and pw%2Fab12 and abc', ['pw/ab12', 'abc'])).toBe(
      'error for *** and *** and abc',
    );
  });

  it('reads a URL with an encoded password, and refuses an unencrypted connection to a database that is not on this machine', async () => {
    const lib = await load<Lib>('lib.mjs');
    expect(lib.parseDbUrl('postgresql://postgres:p%40ss%2Fword@db.example:6543/lms_prod')).toEqual({
      host: 'db.example',
      port: 6543,
      user: 'postgres',
      password: 'p@ss/word',
      database: 'lms_prod',
    });
    const saved = process.env.DB_SSL;
    try {
      delete process.env.DB_SSL;
      expect(lib.sslMode('localhost')).toBe('off');
      expect(() => lib.sslMode('db.example')).toThrow(/off, no-verify or verify-full/);
      process.env.DB_SSL = 'off';
      expect(() => lib.sslMode('db.example')).toThrow(/refused/);
    } finally {
      if (saved === undefined) delete process.env.DB_SSL;
      else process.env.DB_SSL = saved;
    }
  });

  it('names a backup folder with a sortable UTC time', async () => {
    const lib = await load<Lib>('lib.mjs');
    expect(lib.timestampName(new Date('2026-11-25T09:08:07.123Z'))).toBe('20261125T090807Z');
  });
});

describe('comparing two database states', () => {
  const base = (): State => ({
    tables: [
      { name: 'users', unlogged: false, rls: true, forced: true },
      { name: 'rate_limit_counters', unlogged: true, rls: true, forced: true },
    ],
    counts: { users: 5 },
    migrations: { count: 3, last: '0003.sql', sha256: 'aa' },
    digests: { policies: { count: 2, sha256: 'p' }, functions: { count: 9, sha256: 'f' } },
  });

  it('is empty for equal states', async () => {
    const lib = await load<Lib>('lib.mjs');
    expect(lib.compareState(base(), base())).toEqual([]);
  });

  it('names every kind of difference', async () => {
    const lib = await load<Lib>('lib.mjs');
    const a = base();
    a.counts.users = 4;
    expect(lib.compareState(base(), a).join('\n')).toMatch(/users: 4 rows, the backup had 5/);
    const b = base();
    (b.tables[0] as State['tables'][number]).forced = false;
    expect(lib.compareState(base(), b).join('\n')).toMatch(
      /users: row-level security is not enabled AND forced/,
    );
    const c = base();
    c.migrations.sha256 = 'bb';
    expect(lib.compareState(base(), c).join('\n')).toMatch(/applied migrations differ/);
    const d = base();
    (d.digests.policies as { count: number; sha256: string }).sha256 = 'x';
    expect(lib.compareState(base(), d).join('\n')).toMatch(/policies differ/);
    const e = base();
    e.tables.pop();
    expect(lib.compareState(base(), e).join('\n')).toMatch(/set of tables differs/);
    const f = base();
    (f.tables[1] as State['tables'][number]).unlogged = false;
    expect(lib.compareState(base(), f).join('\n')).toMatch(/unlogged flag differs/);
  });
});
