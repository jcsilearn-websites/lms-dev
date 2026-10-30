import { sql } from 'drizzle-orm';
import type { Database } from './client';

/**
 * The PostgreSQL major version this product is built, tested and deployed on: locally, in CI and on Cloud SQL
 * (ADR 0014). Anything else is refused at startup and in the migration runner, so a developer or an environment
 * on another major never discovers a difference in production.
 */
export const REQUIRED_PG_MAJOR = 17;

/** `server_version_num` is e.g. 170010 (17.10) or 180001 (18.1). */
export function pgMajorOf(serverVersionNum: string | number): number {
  return Math.floor(Number(serverVersionNum) / 10_000);
}

export function assertSupportedPostgres(serverVersionNum: string | number): void {
  const num = Number(serverVersionNum);
  const major = pgMajorOf(num);
  if (!Number.isFinite(num) || major !== REQUIRED_PG_MAJOR) {
    const shown = Number.isFinite(num) ? `${major}.${num % 10_000}` : 'unknown';
    throw new Error(
      `PostgreSQL ${REQUIRED_PG_MAJOR} is required (this server is ${shown}). Use PostgreSQL ${REQUIRED_PG_MAJOR} locally, in CI and on Cloud SQL: docs/adr/0014-postgresql-17.md`,
    );
  }
}

/** Checks the server the API / worker is connected to (one statement at startup, never per request). */
export async function assertDatabaseVersion(db: Pick<Database, 'withoutTenant'>): Promise<void> {
  const res = await db.withoutTenant((c) => c.execute(sql`SHOW server_version_num`));
  assertSupportedPostgres(String(res.rows[0]?.server_version_num));
}
