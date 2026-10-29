import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

export const DB_SSL_MODES = ['off', 'no-verify', 'verify-full'] as const;
export type DbSsl = (typeof DB_SSL_MODES)[number];

/** TLS options for the pg driver. verify-full uses the supplied CA (read once at startup). */
export function sslConfig(ssl: DbSsl, sslCa?: string): false | ConnectionOptions {
  if (ssl === 'off') return false;
  if (ssl === 'no-verify') return { rejectUnauthorized: false };
  return sslCa
    ? { rejectUnauthorized: true, ca: readFileSync(sslCa, 'utf8') }
    : { rejectUnauthorized: true };
}

/** A warning to log at startup when TLS verification is disabled. */
export function sslWarning(env: { DB_SSL: DbSsl }): string | undefined {
  return env.DB_SSL === 'no-verify'
    ? 'DB_SSL=no-verify: database TLS certificates are NOT verified. Development/test only; set DB_SSL=verify-full and DB_SSL_CA.'
    : undefined;
}
