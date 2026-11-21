import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintenanceUrl } from '../src/cli/local-setup';
import { passwordFromUrl } from '../src/config/secrets';
import { connectionConfig } from '../src/db/connection';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { getTestDatabases } from './support';

// Migration 0061 replaces eight functions (CREATE OR REPLACE). A replaced function must keep what it had: its SET clauses
// (search_path, enable_* planner switches, jit = off), its grants, SECURITY DEFINER / INVOKER, volatility and owner.
// This test builds a scratch database at migration 0060, records those properties, applies 0061 and compares. It also proves that
// the check INSIDE the migration has teeth: a copy of 0061 that forgets `jit = off` on the grid is refused and rolls back.
// Serial: the migration runner may ALTER ROLE lms_app (cluster-wide) the first time it runs against a new database.

const DB = 'lms_scratch_identity_mig';
const REPLACED = [
  'gradebook_config',
  'gradebook_explain',
  'gradebook_excluded',
  'gradebook_queue',
  'gradebook_snapshot_meta',
  'gradebook_grid',
  'gradebook_review_action',
  'email_suppressions_for_tenant',
];

const dbs = getTestDatabases();
const local = ['localhost', '127.0.0.1'].includes(new URL(dbs.ownerUrl).hostname);
let scratchUrl: string;
let workDir: string;

function scratchOpts(migrationsDir: string) {
  return {
    ownerUrl: scratchUrl,
    ssl: dbs.ssl,
    appPassword: passwordFromUrl(dbs.appUrl),
    migrationsDir,
  };
}

async function snapshot() {
  const c = new pg.Client(connectionConfig(scratchUrl, dbs.ssl));
  await c.connect();
  try {
    const r = await c.query(
      `SELECT p.oid::regprocedure::text AS sig,
              (SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) x) AS config,
              coalesce(p.proacl::text, '') AS acl, p.prosecdef AS definer, p.provolatile AS volatility,
              p.proowner::regrole::text AS owner,
              has_function_privilege('lms_app', p.oid, 'EXECUTE') AS app_can_execute,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.proname = ANY($1) ORDER BY 1`,
      [REPLACED],
    );
    return r.rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  if (!local) return;
  const u = new URL(dbs.ownerUrl);
  u.pathname = `/${DB}`;
  scratchUrl = u.toString();
  const admin = new pg.Client(connectionConfig(maintenanceUrl(dbs.ownerUrl), dbs.ssl));
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
  workDir = await mkdtemp(join(tmpdir(), 'lms-identity-mig-'));
}, 60_000);

afterAll(async () => {
  if (!local) return;
  const admin = new pg.Client(connectionConfig(maintenanceUrl(dbs.ownerUrl), dbs.ssl));
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!local)(
  'migration 0061 keeps the settings and grants of every function it replaces',
  () => {
    it('proconfig, ACL, SECURITY DEFINER, volatility and owner are the same before and after', async () => {
      const all = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      const first = all.find((f) => f.startsWith('0061_')) as string;
      expect(first).toBeDefined();
      const before = join(workDir, 'upto-0060');
      await cp(MIGRATIONS_DIR, before, { recursive: true });
      for (const f of all) if (f >= first) await rm(join(before, f));

      await runMigrations(scratchOpts(before));
      const snapBefore = await snapshot();
      expect(snapBefore.map((r) => r.sig)).toHaveLength(REPLACED.length);
      // the properties worth keeping really exist before (the comparison is not between two empty things)
      const grid = snapBefore.find((r) => r.sig.startsWith('lms.gradebook_grid'));
      expect(grid?.config).toEqual(['enable_nestloop=off', 'jit=off', 'search_path=lms, pg_temp']);
      expect(grid?.app_can_execute).toBe(true);
      expect(grid?.public_can_execute).toBe(false);
      expect(
        snapBefore.find((r) => r.sig.startsWith('lms.email_suppressions_for_tenant'))?.definer,
      ).toBe(true);

      // a copy of 0061 that forgets `jit = off` on the grid: the migration itself refuses it, and nothing is applied
      const broken = join(workDir, 'broken');
      await cp(MIGRATIONS_DIR, broken, { recursive: true });
      const file = join(broken, first);
      const text = await readFile(file, 'utf8');
      expect(text).toContain('SET enable_nestloop = off SET jit = off');
      await writeFile(
        file,
        text.replace('SET enable_nestloop = off SET jit = off', 'SET enable_nestloop = off'),
      );
      await expect(runMigrations(scratchOpts(broken))).rejects.toThrow(/lost a setting or a grant/);
      expect(await snapshot()).toEqual(snapBefore); // rolled back: the old definitions are still there

      // the real one (only up to 0061: a later migration may change a setting on purpose, that is its own test)
      const through = join(workDir, 'through-0061');
      await cp(MIGRATIONS_DIR, through, { recursive: true });
      for (const f of all) if (f > first) await rm(join(through, f));
      const applied = await runMigrations(scratchOpts(through));
      expect(applied.applied.some((f) => f.startsWith('0061_'))).toBe(true);
      expect(await snapshot()).toEqual(snapBefore);
    }, 240_000);
  },
);
