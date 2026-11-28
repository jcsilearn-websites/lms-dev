import pg from 'pg';
import { loadDotEnv } from '../src/config/env';
import { connectionConfig } from '../src/db/connection';
import { assertE2eDatabase } from './e2e-database';

// E2E only (frontend/e2e/specs/20-mfa.spec.ts): makes the second-factor verification of a person's sessions 11 minutes old, so
// that the next sensitive action asks for a step-up without the suite waiting 10 minutes. The guard refuses anything that is not
// the E2E database.
//   tsx test/e2e-age-mfa.ts <email>

async function main(): Promise<void> {
  loadDotEnv();
  const dbs = assertE2eDatabase();
  const email = process.argv[2];
  if (!email) throw new Error('usage: e2e-age-mfa.ts <email>');
  const client = new pg.Client(connectionConfig(dbs.ownerUrl, dbs.ssl, dbs.sslCa));
  await client.connect();
  try {
    const res = await client.query(
      `UPDATE lms.sessions s SET mfa_verified_at = s.mfa_verified_at - interval '11 minutes'
         FROM lms.users u
        WHERE u.id = s.user_id AND u.email = $1 AND s.revoked_at IS NULL AND s.mfa_verified_at IS NOT NULL`,
      [email],
    );
    if (!res.rowCount) throw new Error(`no verified session of ${email}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});
