import type pg from 'pg';
import { createMfaCrypto, type MfaCrypto, parseMfaKeys } from '../core/mfa-crypto';
import { newId } from '../core/uuid';

// KEY ROTATION of the second factor (docs/production-config.md), owner connection:
//   pnpm mfa:rekey              re-encrypts every TOTP secret under the FIRST key of MFA_ENCRYPTION_KEYS, then prints what each key
//                               id still protects. An old key may be removed only when it shows 0 secrets AND 0 recovery codes.
// A recovery-code HASH cannot be re-keyed (the code is not kept): its key stays until the person has used or replaced the codes.
// Nothing printed is a secret.

export interface KeyUsage {
  kid: string;
  secrets: number;
  unusedRecoveryCodes: number;
}

export async function mfaKeyUsage(client: pg.ClientBase): Promise<KeyUsage[]> {
  const res = await client.query<{ kid: string; secrets: number; codes: number }>(`
    SELECT kid, sum(secrets)::int AS secrets, sum(codes)::int AS codes FROM (
      SELECT key_id AS kid, 1 AS secrets, 0 AS codes FROM lms.user_mfa
      UNION ALL
      SELECT key_id, 0, 1 FROM lms.user_mfa_recovery_codes WHERE used_at IS NULL
    ) x GROUP BY kid ORDER BY kid`);
  return res.rows.map((r) => ({ kid: r.kid, secrets: r.secrets, unusedRecoveryCodes: r.codes }));
}

/** One transaction with its audit row. Returns how many secrets moved to the current key. */
export async function rekeyMfaSecrets(client: pg.ClientBase, crypto: MfaCrypto): Promise<number> {
  await client.query('BEGIN');
  try {
    const rows = await client.query<{
      user_id: string;
      secret_ciphertext: Buffer;
      secret_nonce: Buffer;
      key_id: string;
    }>(
      `SELECT user_id, secret_ciphertext, secret_nonce, key_id FROM lms.user_mfa
        WHERE key_id <> $1 ORDER BY user_id FOR NO KEY UPDATE`,
      [crypto.currentKid],
    );
    for (const row of rows.rows) {
      const secret = crypto.open(row.user_id, {
        kid: row.key_id,
        nonce: row.secret_nonce,
        ciphertext: row.secret_ciphertext,
      });
      const sealed = crypto.seal(row.user_id, secret);
      await client.query(
        `UPDATE lms.user_mfa SET secret_ciphertext = $2, secret_nonce = $3, key_id = $4, updated_at = now()
          WHERE user_id = $1`,
        [row.user_id, sealed.ciphertext, sealed.nonce, sealed.kid],
      );
    }
    if (rows.rows.length > 0) {
      await client.query(
        `SELECT lms.auth_audit_platform($1, NULL, 'platform.mfa_secrets_rekeyed', 'user', NULL,
                                        jsonb_build_object('secrets', $2::int, 'keyId', $3::text), NULL)`,
        [newId(), rows.rows.length, crypto.currentKid],
      );
    }
    await client.query('COMMIT');
    return rows.rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main(): Promise<void> {
  const { loadDotEnv, parseOwnerEnv } = await import('../config/env');
  const { connectionConfig } = await import('../db/connection');
  const { default: driver } = await import('pg');
  loadDotEnv();
  const env = parseOwnerEnv();
  const keys = parseMfaKeys(process.env.MFA_ENCRYPTION_KEYS);
  if (keys.length === 0) throw new Error('MFA_ENCRYPTION_KEYS is not set');
  const crypto = createMfaCrypto(keys);
  const client = new driver.Client(connectionConfig(env.DATABASE_URL, env.DB_SSL, env.DB_SSL_CA));
  await client.connect();
  try {
    const moved = await rekeyMfaSecrets(client, crypto);
    console.log(`${moved} secret(s) re-encrypted under key "${crypto.currentKid}"`);
    for (const u of await mfaKeyUsage(client)) {
      console.log(
        `key "${u.kid}": ${u.secrets} secret(s), ${u.unusedRecoveryCodes} unused recovery code(s)`,
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// run only as a script (the tests and the restore drill import the functions)
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/cli/mfa-rekey.ts')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'failed');
    process.exit(1);
  });
}
