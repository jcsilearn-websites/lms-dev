import {
  assertTestDatabases,
  databaseName,
  type TestDatabases,
  TestGuardError,
  withDatabase,
} from './guards';

/** The one database the Playwright end-to-end tests may reset and write to. */
export const E2E_DATABASE_NAME = 'lms_e2e';

/**
 * Guard for the E2E database. It reuses every refusal of the test-database guard (production, missing
 * or invalid TEST_ URLs, the dev database NAME on any host, same project, the TLS policy: DB_SSL=off
 * only for localhost) and adds its own: the E2E database lives on the same server and with the same
 * credentials as the TEST_ URLs, is called exactly `lms_e2e`, and is never the dev database, the
 * TEST base database or one of its per-worker databases (`<base>_<n>`).
 */
export function assertE2eDatabase(
  source: Record<string, string | undefined> = process.env,
): TestDatabases {
  // the test guard resolves the BASE test database (no worker suffix) and refuses the unsafe cases
  const base = assertTestDatabases({ ...source, VITEST_POOL_ID: undefined, REMOTE_DB: '1' });
  const name = E2E_DATABASE_NAME;
  const clash = [
    base.baseName,
    ...[source.DATABASE_URL, source.DATABASE_APP_URL]
      .filter((u): u is string => !!u)
      .map(databaseName),
  ];
  if (clash.includes(name) || new RegExp(`^${base.baseName}_\\d+$`).test(name)) {
    throw new TestGuardError(
      `the E2E database name "${name}" clashes with the dev or test databases`,
    );
  }
  return {
    ...base,
    name,
    ownerUrl: withDatabase(base.ownerUrl, name),
    appUrl: withDatabase(base.appUrl, name),
  };
}
