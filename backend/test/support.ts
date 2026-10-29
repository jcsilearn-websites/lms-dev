import pg from 'pg';
import { ensureCompatRoles, ensureDatabase, maintenanceUrl } from '../src/cli/local-setup';
import { loadDotEnv } from '../src/config/env';
import { passwordFromUrl } from '../src/config/secrets';
import { createPasswordHasher } from '../src/core/password';
import { newId } from '../src/core/uuid';
import { connectionConfig, createPool } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { assertTestDatabases, type TestDatabases } from './guards';
import { dbWorkerCount, isRemoteDb } from './workers';

/** Test helpers. Every entry point re-checks the guard: tests can never touch the dev project. */
export function getTestDatabases(): TestDatabases {
  loadDotEnv();
  return assertTestDatabases();
}

/**
 * Called once per run by the global setup (main process): makes sure every worker database exists and
 * is migrated. Local profile: <TEST base name>_1 ... _N are created when missing (the roles anon /
 * authenticated and lms_app exist cluster-wide). REMOTE_DB=1: the one given database is only migrated.
 * The databases are reused between runs: an up-to-date one costs a few queries.
 */
export async function prepareTestDatabases(): Promise<{ workers: number; names: string[] }> {
  loadDotEnv();
  const remote = isRemoteDb();
  const workers = remote ? 1 : dbWorkerCount();
  const names: string[] = [];
  for (let id = 1; id <= workers; id++) {
    // the same guard as every test entry point, for the database of worker `id`
    const dbs = assertTestDatabases({ ...process.env, VITEST_POOL_ID: String(id) });
    names.push(dbs.name);
    if (!remote) {
      const admin = new pg.Client(
        connectionConfig(maintenanceUrl(dbs.ownerUrl), dbs.ssl, dbs.sslCa),
      );
      await admin.connect();
      try {
        await ensureCompatRoles(admin);
        await ensureDatabase(admin, dbs.name);
      } finally {
        await admin.end();
      }
    }
    // one at a time: the first migration of a database sets the cluster-wide lms_app password
    const result = await runMigrations({
      ownerUrl: dbs.ownerUrl,
      ssl: dbs.ssl,
      sslCa: dbs.sslCa,
      appPassword: passwordFromUrl(dbs.appUrl),
    });
    // After a password change a pooler may reject lms_app logins for a short while: wait for it.
    await waitForAppLogin(dbs, result.passwordChanged ? 90_000 : 30_000);
  }
  return { workers, names };
}

async function waitForAppLogin(dbs: TestDatabases, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client(connectionConfig(dbs.appUrl, dbs.ssl, dbs.sslCa));
    try {
      await client.connect();
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Owner pool on the TEST project (used to arrange fixtures and inspect catalogs). */
export function testOwnerPool(max = 2): pg.Pool {
  const dbs = getTestDatabases();
  return createPool({
    url: dbs.ownerUrl,
    ssl: dbs.ssl,
    sslCa: dbs.sslCa,
    max,
    connectionTimeoutMs: 20_000,
    applicationName: 'lms-test-owner',
  });
}

/** Raw lms_app pool on the TEST project (for tests that must bypass withTenant). */
export function testAppPool(max = 2): pg.Pool {
  const dbs = getTestDatabases();
  return createPool({
    url: dbs.appUrl,
    ssl: dbs.ssl,
    sslCa: dbs.sslCa,
    max,
    connectionTimeoutMs: 20_000,
    applicationName: 'lms-test-app',
  });
}

export function testAppDbOptions(max = 2) {
  const dbs = getTestDatabases();
  return {
    url: dbs.appUrl,
    ssl: dbs.ssl,
    sslCa: dbs.sslCa,
    max,
    connectionTimeoutMs: 20_000,
    applicationName: 'lms-test-api',
  };
}

/** TRUNCATE every table in schema lms (except the migration bookkeeping tables). Owner connection, test DB only. */
export async function resetLms(): Promise<void> {
  const dbs = getTestDatabases();
  const client = new pg.Client(connectionConfig(dbs.ownerUrl, dbs.ssl, dbs.sslCa));
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'lms' AND tablename NOT IN ('schema_migrations', 'role_password_state')",
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `lms."${r.tablename}"`).join(', ');
      await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export interface TenantFixture {
  tenantId: string;
  adminUserId: string;
  adminMembershipId: string;
  memberUserId: string;
  memberMembershipId: string;
}

/** Insert a tenant with one institution_admin and one member (via the owner connection). */
export async function createTenantFixture(owner: pg.Pool, slug: string): Promise<TenantFixture> {
  const f: TenantFixture = {
    tenantId: newId(),
    adminUserId: newId(),
    adminMembershipId: newId(),
    memberUserId: newId(),
    memberMembershipId: newId(),
  };
  await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
    f.tenantId,
    slug,
    `Tenant ${slug}`,
  ]);
  await owner.query(
    `INSERT INTO lms.users (id, email, display_name) VALUES
       ($1, $2, 'Admin'), ($3, $4, 'Member')`,
    [f.adminUserId, `admin@${slug}.test`, f.memberUserId, `member@${slug}.test`],
  );
  await owner.query(
    `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES
       ($1, $2, $3, 'institution_admin'), ($4, $2, $5, 'member')`,
    [f.adminMembershipId, f.tenantId, f.adminUserId, f.memberMembershipId, f.memberUserId],
  );
  return f;
}

// ---------------------------------------------------------------- auth fixtures
export const TEST_PASSWORD = 'correct-horse-battery-staple';

/** Insert (or replace) a user's password through the owner connection. */
export async function setPassword(owner: pg.Pool, userId: string, password = TEST_PASSWORD) {
  const hash = await getTestHasher().hash(password);
  await owner.query(
    `INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       failed_attempts = 0, locked_until = NULL`,
    [userId, hash],
  );
}

let hasher: ReturnType<typeof createPasswordHasher> | undefined;
function getTestHasher() {
  hasher ??= createPasswordHasher({ concurrency: 2 });
  return hasher;
}

export interface AuthFixture extends TenantFixture {
  slug: string;
  host: string;
  adminEmail: string;
  memberEmail: string;
}

/** A tenant with an institution admin and a member, both with TEST_PASSWORD. */
export async function createAuthFixture(owner: pg.Pool, slug: string): Promise<AuthFixture> {
  const f = await createTenantFixture(owner, slug);
  await setPassword(owner, f.adminUserId);
  await setPassword(owner, f.memberUserId);
  return {
    ...f,
    slug,
    host: `${slug}.localhost`,
    adminEmail: `admin@${slug}.test`,
    memberEmail: `member@${slug}.test`,
  };
}

export async function createPlatformAdmin(
  owner: pg.Pool,
  email = 'root@platform.test',
): Promise<{ userId: string; email: string }> {
  const userId = newId();
  await owner.query(
    "INSERT INTO lms.users (id, email, display_name, is_platform_admin) VALUES ($1, $2, 'Root', true)",
    [userId, email],
  );
  await setPassword(owner, userId);
  return { userId, email };
}
