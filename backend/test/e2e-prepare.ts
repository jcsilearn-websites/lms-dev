import pg from 'pg';
import { ensureCompatRoles, ensureDatabase, maintenanceUrl } from '../src/cli/local-setup';
import { loadDotEnv } from '../src/config/env';
import { passwordFromUrl } from '../src/config/secrets';
import { connectionConfig, createPool } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { assertE2eDatabase } from './e2e-database';
import { addMember } from './fixtures';
import { createAuthFixture, createPlatformAdmin, TEST_PASSWORD } from './support';

// Prepares the E2E database before every Playwright run (called by frontend/e2e/global-setup.ts):
//   guard -> create the database if missing -> migrate -> TRUNCATE every table -> seed.
// Prints the connection details the API and worker processes need as JSON on the last line of stdout.
// The seed: two colleges (e2e-one, e2e-two), each with an institution admin and a member, one extra
// member to suspend, and a platform admin. Every account has TEST_PASSWORD.

async function main(): Promise<void> {
  loadDotEnv();
  const dbs = assertE2eDatabase();

  const admin = new pg.Client(connectionConfig(maintenanceUrl(dbs.ownerUrl), dbs.ssl, dbs.sslCa));
  await admin.connect();
  try {
    await ensureCompatRoles(admin);
    await ensureDatabase(admin, dbs.name);
  } finally {
    await admin.end();
  }
  await runMigrations({
    ownerUrl: dbs.ownerUrl,
    ssl: dbs.ssl,
    sslCa: dbs.sslCa,
    appPassword: passwordFromUrl(dbs.appUrl),
  });

  const owner = createPool({
    url: dbs.ownerUrl,
    ssl: dbs.ssl,
    sslCa: dbs.sslCa,
    max: 2,
    connectionTimeoutMs: 20_000,
    applicationName: 'lms-e2e-prepare',
  });
  try {
    const { rows } = await owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'lms' AND tablename NOT IN ('schema_migrations', 'role_password_state')",
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `lms."${r.tablename}"`).join(', ');
      await owner.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }

    const one = await createAuthFixture(owner, 'e2e-one');
    await createAuthFixture(owner, 'e2e-two');
    await owner.query("UPDATE lms.users SET display_name = 'Ada Admin' WHERE email = $1", [
      one.adminEmail,
    ]);
    await addMember(owner, one.tenantId, 'sam.suspend@e2e-one.test', {
      displayName: 'Sam Suspend',
    });
    await createPlatformAdmin(owner, 'root@e2e.test');

    // Lighthouse and the screenshots want a realistic list: E2E_EXTRA_MEMBERS plain members in e2e-one
    const extra = Number(process.env.E2E_EXTRA_MEMBERS ?? 0);
    if (Number.isInteger(extra) && extra > 0) {
      await owner.query(
        `WITH u AS (
           INSERT INTO lms.users (id, email, display_name)
           SELECT gen_random_uuid(), 'person' || g || '@e2e-one.test', 'Person ' || g
             FROM generate_series(1, $2::int) g
           RETURNING id)
         INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
         SELECT gen_random_uuid(), $1, id, 'member', 'active' FROM u`,
        [one.tenantId, extra],
      );
    }
  } finally {
    await owner.end();
  }

  // The runner (frontend/scripts/e2e.mjs) reads this line from stdout and hands the URLs to the API and
  // worker processes through their environment. Nothing secret is written to a file.
  console.log(`E2E database ${dbs.name} is ready (migrated, reset, seeded)`);
  console.log(
    `E2E_ENV ${JSON.stringify({ ownerUrl: dbs.ownerUrl, appUrl: dbs.appUrl, ssl: dbs.ssl, password: TEST_PASSWORD })}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'failed');
  process.exit(1);
});
