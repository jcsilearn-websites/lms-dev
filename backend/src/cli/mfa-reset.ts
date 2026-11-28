import type pg from 'pg';

// BREAK GLASS (docs/mfa-runbook.md), owner connection:
//   pnpm mfa:reset --email person@example.com
// Removes the second factor of one account AT ONCE, for the case the four-eyes reset cannot cover (no three platform
// administrators who can sign in). Same effect as an executed reset: factor, codes and challenges gone, every session ended, the
// password invalidated, any open request cancelled; audited as break glass on the platform log and on the log of every college the
// person administers, and the person is e-mailed. One database statement (lms.mfa_break_glass): all of it or none of it.
// Nothing printed is a secret.

export type BreakGlassResult = 'ok' | 'not_found' | 'not_enrolled';

export async function breakGlassReset(
  client: pg.ClientBase,
  email: string,
  now: Date = new Date(),
): Promise<BreakGlassResult> {
  const res = await client.query<{ r: { result: BreakGlassResult } }>(
    'SELECT lms.mfa_break_glass($1, $2) AS r',
    [email, now],
  );
  return res.rows[0]?.r.result ?? 'not_found';
}

async function main(): Promise<void> {
  const { loadDotEnv, parseOwnerEnv } = await import('../config/env');
  const { connectionConfig } = await import('../db/connection');
  const { assertValidEmail } = await import('../core/email');
  const { default: driver } = await import('pg');
  loadDotEnv();
  const env = parseOwnerEnv();
  const at = process.argv.indexOf('--email');
  const email = assertValidEmail(at === -1 ? '' : (process.argv[at + 1] ?? ''));
  const client = new driver.Client(connectionConfig(env.DATABASE_URL, env.DB_SSL, env.DB_SSL_CA));
  await client.connect();
  try {
    const result = await breakGlassReset(client, email);
    if (result === 'not_found') throw new Error('no account with this address');
    if (result === 'not_enrolled') {
      throw new Error('this account has no second factor: nothing was changed');
    }
    console.log(
      'second factor removed, sessions ended, password invalidated: the person chooses a new password ("forgot password")',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

// run only as a script (the tests import the function)
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/cli/mfa-reset.ts')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'failed');
    process.exit(1);
  });
}
