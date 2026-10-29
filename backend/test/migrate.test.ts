import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passwordFromUrl } from '../src/config/secrets';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { getTestDatabases, testOwnerPool } from './support';

let owner: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
});
afterAll(async () => {
  await owner.end();
});

function opts(migrationsDir?: string) {
  const dbs = getTestDatabases();
  return {
    ownerUrl: dbs.ownerUrl,
    ssl: dbs.ssl,
    appPassword: passwordFromUrl(dbs.appUrl),
    ...(migrationsDir ? { migrationsDir } : {}),
  };
}

describe('migration runner', () => {
  it('records every migration with filename + checksum, and is idempotent', async () => {
    const result = await runMigrations(opts());
    expect(result.applied).toEqual([]);
    // the password is only re-set when it changes (each ALTER ROLE disturbs pooled logins)
    expect(result.passwordChanged).toBe(false);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    expect(result.skipped).toEqual(files);
    const { rows } = await owner.query<{ filename: string; checksum: string; applied_at: Date }>(
      'SELECT * FROM lms.schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toEqual(files);
    for (const r of rows) {
      expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(r.applied_at).toBeInstanceOf(Date);
    }
  });

  it('fails when an already-applied migration file was modified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lms-migrations-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const first = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()[0] as string;
    const original = await readFile(join(dir, first), 'utf8');
    await writeFile(join(dir, first), `${original}\n-- tampered\n`);
    await expect(runMigrations(opts(dir))).rejects.toThrow(/checksum mismatch/);
  });

  it('serialises concurrent runs with an advisory lock', async () => {
    const results = await Promise.all([runMigrations(opts()), runMigrations(opts())]);
    for (const r of results) expect(r.applied).toEqual([]);
  });

  it('rolls back a failing migration and does not record it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lms-migrations-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await writeFile(
      join(dir, '9999_broken.sql'),
      'CREATE TABLE lms.should_not_exist (id int); SELECT 1/0;',
    );
    await expect(runMigrations(opts(dir))).rejects.toThrow(/9999_broken\.sql failed/);
    const { rows } = await owner.query("SELECT to_regclass('lms.should_not_exist') AS t");
    expect(rows[0]?.t).toBeNull();
    const rec = await owner.query(
      "SELECT 1 FROM lms.schema_migrations WHERE filename = '9999_broken.sql'",
    );
    expect(rec.rows).toHaveLength(0);
  });

  it('never leaks the lms_app password in errors', async () => {
    const o = opts();
    const dir = await mkdtemp(join(tmpdir(), 'lms-migrations-'));
    await writeFile(join(dir, '0001_x.sql'), `SELECT '${o.appPassword}'::int;`);
    try {
      await runMigrations({ ...o, migrationsDir: dir });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(o.appPassword);
    }
  });
});
