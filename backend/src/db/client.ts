import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { isUuid } from '../core/uuid';
import { createPool, type PoolOptions } from './connection';

/**
 * What repositories receive from the service: a Drizzle handle bound to ONE connection. Inside
 * withTenant / withUser that connection has an open transaction with the RLS context set; inside
 * withoutTenant it is an autocommit pooled connection with no tenant context.
 */
export type Executor = NodePgDatabase;
/** @deprecated alias kept for readability at call sites that mean "inside withTenant". */
export type TenantTx = Executor;

export interface WithTenantOptions {
  /** Sets app.user_id so the "current user" can see their own users row. */
  userId?: string;
}

export interface Database {
  /**
   * The ONLY way application code touches tenant data. Opens a transaction, sets the
   * transaction-local app.tenant_id (and app.user_id when given), and runs fn. Commits if fn
   * resolves, rolls back if it throws. Costs 2 round trips of overhead (BEGIN + context in one
   * simple-query message, then COMMIT) plus the statements fn sends.
   */
  withTenant<T>(
    tenantId: string,
    fn: (tx: Executor) => Promise<T>,
    opts?: WithTenantOptions,
  ): Promise<T>;
  /**
   * Context for a signed-in user with no tenant (platform-admin sessions): sets only app.user_id.
   * Tenant tables return no rows here; sessions of that user are visible (see policy sessions_own).
   */
  withUser<T>(userId: string, fn: (tx: Executor) => Promise<T>): Promise<T>;
  /**
   * PRE-TENANT entry point: a plain autocommit connection with NO tenant context. RLS makes every
   * tenant table empty here, so it is only useful for calling the SECURITY DEFINER auth functions
   * (tenant lookup by slug, login, session lookup, token redemption). One statement = one round
   * trip; anything that needs a transaction belongs in withTenant / withUser.
   */
  withoutTenant<T>(fn: (db: Executor) => Promise<T>): Promise<T>;
  /** `SELECT 1` with a hard timeout; rejects if the database is unreachable or slow. */
  ping(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export function createDb(opts: PoolOptions): Database {
  const pool = createPool(opts);
  const autocommit = drizzle({ client: pool });

  /**
   * BEGIN + RLS context in a single simple-query round trip, then fn, then COMMIT (ROLLBACK on
   * error). `contextSql` may only contain values already validated as UUIDs: never user text.
   */
  async function inTransaction<T>(
    contextSql: string,
    fn: (tx: Executor) => Promise<T>,
  ): Promise<T> {
    const client: pg.PoolClient = await pool.connect();
    let broken = false;
    try {
      await client.query(`BEGIN; ${contextSql}`);
      const result = await fn(drizzle({ client }));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // the connection is unusable: drop it instead of returning it to the pool
      }
      throw err;
    } finally {
      client.release(broken || undefined);
    }
  }

  const setting = (name: string, uuid: string) => `set_config('${name}', '${uuid}', true)`;

  return {
    async withTenant(tenantId, fn, options) {
      if (!isUuid(tenantId)) throw new TypeError('withTenant: tenantId must be a UUID');
      if (options?.userId !== undefined && !isUuid(options.userId)) {
        throw new TypeError('withTenant: userId must be a UUID');
      }
      const settings = [setting('app.tenant_id', tenantId)];
      if (options?.userId) settings.push(setting('app.user_id', options.userId));
      return inTransaction(`SELECT ${settings.join(', ')}`, fn);
    },

    async withUser(userId, fn) {
      if (!isUuid(userId)) throw new TypeError('withUser: userId must be a UUID');
      return inTransaction(`SELECT ${setting('app.user_id', userId)}`, fn);
    },

    async withoutTenant(fn) {
      // The pooled connection carries no session state (all settings are transaction-local).
      return fn(autocommit);
    },

    async ping(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('database ping timed out')), timeoutMs);
      });
      try {
        await Promise.race([pool.query('select 1'), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    async close() {
      await pool.end();
    },
  };
}
