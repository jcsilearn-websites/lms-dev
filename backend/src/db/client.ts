import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { withSpan } from '../core/telemetry';
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
  /** The pool right now: connections open, idle, and callers waiting for one (a gauge for /metrics). */
  stats(): { total: number; idle: number; waiting: number };
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
    // one span per transaction (the statements inside are not spanned one by one: the round-trip budget already counts them)
    return withSpan('db.transaction', { 'db.system': 'postgresql' }, async () => {
      const client: pg.PoolClient = await pool.connect();
      let broken = false;
      // A connection that dies while a request holds it BETWEEN two statements (a restart, a failover) emits 'error' on the checked-out
      // client. The pool only listens on idle clients, so without this listener the error is uncaught and takes the whole process
      // down. Found by test/resilience.postgres.test.ts. The request itself fails with its next statement; the connection is discarded.
      const onClientError = (err: Error) => {
        broken = true;
        opts.onError?.(err);
      };
      client.on('error', onClientError);
      try {
        await client.query(`BEGIN; ${contextSql}`);
        const result = await fn(drizzle({ client }));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          // a ROLLBACK on a dead connection must not hang the request a second time: give it a short, hard deadline
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            client.query('ROLLBACK'),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('rollback timed out')), 2000);
            }),
          ]).finally(() => clearTimeout(timer));
        } catch {
          broken = true; // the connection is unusable: drop it instead of returning it to the pool
        }
        throw err;
      } finally {
        client.removeListener('error', onClientError);
        client.release(broken || undefined);
      }
    });
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
      return withSpan('db.statement', { 'db.system': 'postgresql' }, () => fn(autocommit));
    },

    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),

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
