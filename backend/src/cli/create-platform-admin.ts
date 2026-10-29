import { createInterface } from 'node:readline';
import pg from 'pg';
import { EnvError, loadDotEnv, parseOwnerEnv } from '../config/env';
import { sslWarning } from '../config/ssl';
import { assertValidEmail } from '../core/email';
import { createPasswordHasher } from '../core/password';
import { newId } from '../core/uuid';
import { connectionConfig } from '../db/connection';
import { assertPasswordAllowed } from '../modules/auth';

// Bootstrap CLI (NOT an HTTP endpoint): creates the first platform admin or resets that account's
// password. Runs with the OWNER connection (DATABASE_URL).
//   pnpm admin:create --email root@example.com [--name "Root Admin"]
// The password is read from the ADMIN_PASSWORD env var or typed at a hidden prompt: never from
// command-line arguments (which end up in shell history and process listings).

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // mute everything except the question itself
    const muted = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = muted._writeToOutput.bind(rl);
    muted._writeToOutput = (s) => {
      if (s.startsWith(question)) original(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error('No terminal for a password prompt: set ADMIN_PASSWORD in the environment');
  }
  const first = await promptHidden('New password: ');
  const second = await promptHidden('Repeat password: ');
  if (first !== second) throw new Error('Passwords do not match');
  return first;
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseOwnerEnv();
  const email = assertValidEmail(arg('email') ?? '');
  const name = arg('name') ?? 'Platform Admin';
  const password = await readPassword();
  assertPasswordAllowed(password);
  const hash = await createPasswordHasher({ concurrency: 1 }).hash(password);

  const warning = sslWarning(env);
  if (warning) console.warn(`WARNING: ${warning}`);
  const client = new pg.Client(connectionConfig(env.DATABASE_URL, env.DB_SSL, env.DB_SSL_CA));
  await client.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      `INSERT INTO lms.users (id, email, display_name, is_platform_admin)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (email) DO UPDATE SET is_platform_admin = true, updated_at = now()
       RETURNING id`,
      [newId(), email, name],
    );
    const userId = user.rows[0]?.id as string;
    await client.query(
      `INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, password_updated_at = now(),
             failed_attempts = 0, locked_until = NULL, updated_at = now()`,
      [userId, hash],
    );
    await client.query(
      `SELECT lms.auth_audit_platform($1, NULL, 'platform_admin.bootstrapped', 'user', $2, '{}'::jsonb, NULL)`,
      [newId(), userId],
    );
    await client.query('COMMIT');
    console.log(`platform admin ready: ${email} (sign in at admin.<APP_BASE_DOMAIN>)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof EnvError || err instanceof Error ? err.message : 'failed');
  process.exit(1);
});
