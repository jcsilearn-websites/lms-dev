import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createDb, type Database } from '../src/db/client';
import { expectPgError, SQLSTATE } from './helpers';
import {
  type AuthFixture,
  createAuthFixture,
  testAppDbOptions,
  testAppPool,
  testOwnerPool,
} from './support';

// The import_* SECURITY DEFINER functions (migration 0013): hardened like the auth_* functions, bound to
// the caller's tenant and to the staged rows, with bounded deletes.

let owner: pg.Pool;
let app: pg.Pool;
let db: Database;
let A: AuthFixture;
let B: AuthFixture;
const IMPORT_FUNCTIONS = ['import_ensure_users', 'import_purge_rows', 'import_reap_dead'];

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  db = createDb(testAppDbOptions(2));
  A = await createAuthFixture(owner, 'imf-a');
  B = await createAuthFixture(owner, 'imf-b');
});
afterAll(async () => {
  await db.close();
  await app.end();
  await owner.end();
});

describe('import_* functions are hardened', () => {
  it('are SECURITY DEFINER, owner-owned, with a pinned search_path', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig AS config
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'import\\_%'`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...IMPORT_FUNCTIONS].sort());
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe(me);
      expect(r.config, r.proname).toContain('search_path=lms, pg_temp');
    }
  });

  it('EXECUTE is granted to lms_app only', async () => {
    const { rows } = await owner.query<{ proname: string; grantees: string[] }>(
      `SELECT p.proname,
              COALESCE(array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), '{}') AS grantees
         FROM pg_proc p LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
        WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'import\\_%'
        GROUP BY p.proname`,
    );
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    expect(rows).toHaveLength(IMPORT_FUNCTIONS.length);
    for (const r of rows) {
      expect(r.grantees, r.proname).toContain('lms_app');
      expect(r.grantees, r.proname).not.toContain('PUBLIC');
      for (const g of r.grantees) expect([me, 'lms_app'], `${r.proname} -> ${g}`).toContain(g);
    }
  });

  it('lms_app cannot DELETE staged rows directly: only the bounded purge function can', async () => {
    await expectPgError(app.query('DELETE FROM lms.import_rows'), SQLSTATE.insufficientPrivilege);
    await expectPgError(app.query('DELETE FROM lms.import_jobs'), SQLSTATE.insufficientPrivilege);
    const r = await app.query('SELECT lms.import_purge_rows(36500, -5) AS n'); // nothing that old; batch clamped
    expect(r.rows[0].n).toBe(0);
  });
});

describe('import_ensure_users is bound to the tenant and to the staged rows', () => {
  async function stage(tenantId: string, emails: string[], status = 'valid') {
    const importId = newId();
    await owner.query(
      "INSERT INTO lms.import_jobs (id, tenant_id, kind, file_name, status, created_by_user_id) VALUES ($1, $2, 'faculty', 'f.csv', 'validated', $3)",
      [importId, tenantId, tenantId === A.tenantId ? A.adminUserId : B.adminUserId],
    );
    for (const [i, email] of emails.entries()) {
      await owner.query(
        "INSERT INTO lms.import_rows (tenant_id, import_id, row_number, status, raw, email) VALUES ($1, $2, $3, $4, '{}', $5)",
        [tenantId, importId, i + 2, status, email],
      );
    }
    return importId;
  }
  const call = (tenantId: string, importId: string, emails: string[]) =>
    db.withTenant(tenantId, (tx) =>
      tx.execute(
        // the same call the processing batch makes
        sql.raw(
          `SELECT * FROM lms.import_ensure_users('${tenantId}'::uuid, '${importId}'::uuid,
             '{${emails.map(() => newId()).join(',')}}'::uuid[], '{${emails.join(',')}}'::text[], '{${emails.map(() => 'N').join(',')}}'::text[])`,
        ),
      ),
    );

  it('creates accounts only for staged VALID rows of that import, and reports created vs existing', async () => {
    const importId = await stage(A.tenantId, ['staged-1@imf.test', 'staged-2@imf.test']);
    await owner.query(
      "INSERT INTO lms.users (id, email, display_name) VALUES ($1, 'staged-2@imf.test', 'Already There')",
      [newId()],
    );
    const res = await call(A.tenantId, importId, [
      'staged-1@imf.test',
      'staged-2@imf.test',
      'not-staged@imf.test',
    ]);
    const byEmail = Object.fromEntries(res.rows.map((r) => [r.r_email as string, r.r_created]));
    expect(byEmail).toEqual({ 'staged-1@imf.test': true, 'staged-2@imf.test': false });
    const stranger = await owner.query(
      "SELECT 1 FROM lms.users WHERE email = 'not-staged@imf.test'",
    );
    expect(stranger.rowCount).toBe(0); // an email that is not staged is never created
    const kept = await owner.query(
      "SELECT display_name FROM lms.users WHERE email = 'staged-2@imf.test'",
    );
    expect(kept.rows[0].display_name).toBe('Already There'); // existing accounts are never renamed
  });

  it('refuses a tenant that is not the session tenant, finds nothing of another tenant, and ignores rows that are not valid', async () => {
    const importId = await stage(A.tenantId, ['wrong-tenant@imf.test']);
    // the caller is in tenant B's context but names tenant A: refused outright
    await expect(
      db.withTenant(B.tenantId, (tx) =>
        tx.execute(
          sql.raw(
            `SELECT * FROM lms.import_ensure_users('${A.tenantId}'::uuid, '${importId}'::uuid, '{${newId()}}'::uuid[], '{wrong-tenant@imf.test}'::text[], '{N}'::text[])`,
          ),
        ),
      ),
    ).rejects.toThrow();
    // tenant B naming ITS OWN id but tenant A's import: the staged rows are not B's, so nothing is created
    expect((await call(B.tenantId, importId, ['wrong-tenant@imf.test'])).rows).toHaveLength(0);
    const invalidId = await stage(A.tenantId, ['invalid-row@imf.test'], 'invalid');
    expect((await call(A.tenantId, invalidId, ['invalid-row@imf.test'])).rows).toHaveLength(0);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM lms.users WHERE email IN ('wrong-tenant@imf.test', 'invalid-row@imf.test')",
        )
      ).rowCount,
    ).toBe(0);
  });

  it('with no tenant context at all it refuses', async () => {
    await expectPgError(
      app.query(
        "SELECT * FROM lms.import_ensure_users(gen_random_uuid(), gen_random_uuid(), '{}'::uuid[], '{}'::text[], '{}'::text[])",
      ),
      SQLSTATE.insufficientPrivilege,
    );
  });
});
