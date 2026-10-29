import pg from 'pg';
import type { DbSsl } from '../config/ssl';
import { sslConfig } from '../config/ssl';

/**
 * Build pg config from a URL. libpq-style sslmode/uselibpqcompat params are stripped and TLS is
 * driven by our explicit DB_SSL setting instead (pg's `sslmode=require` means verify-full, which
 * fails against the Supabase pooler's CA chain).
 */
export function connectionConfig(url: string, ssl: DbSsl, sslCa?: string): pg.PoolConfig {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('uselibpqcompat');
  return {
    connectionString: u.toString(),
    ssl: sslConfig(ssl, sslCa),
  };
}

export interface PoolOptions {
  url: string;
  ssl: DbSsl;
  sslCa?: string | undefined;
  max: number;
  /** Time to wait for a free/new connection. Generous in tests (remote DB), short for readiness. */
  connectionTimeoutMs?: number;
  applicationName: string;
  onError?: (err: Error) => void;
  /**
   * Called once per statement SENT to the server (every client.query call = one network round trip,
   * including BEGIN, set_config and COMMIT). Used by the query-budget tests; unset in production.
   */
  onStatement?: (text: string) => void;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    ...connectionConfig(opts.url, opts.ssl, opts.sslCa),
    max: opts.max,
    application_name: opts.applicationName,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
    idleTimeoutMillis: 30_000,
  });
  // An unhandled 'error' on an idle client would crash the process.
  pool.on('error', (err) => opts.onError?.(err));
  const onStatement = opts.onStatement;
  if (onStatement) {
    pool.on('connect', (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
        const first = args[0];
        onStatement(typeof first === 'string' ? first : ((first as { text?: string })?.text ?? ''));
        return original(...args);
      };
    });
  }
  return pool;
}
