import { availableParallelism } from 'node:os';

/** Upper bound: every worker holds a database of its own and a handful of connections. */
export const MAX_DB_WORKERS = 16;

/**
 * How many Vitest workers run DB test files in parallel, i.e. how many databases
 * (<TEST base name>_1 ... _N) exist. TEST_DB_WORKERS, else CPU cores - 1 (at least 1).
 */
export function dbWorkerCount(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.TEST_DB_WORKERS);
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, MAX_DB_WORKERS);
  return Math.min(Math.max(1, availableParallelism() - 1), MAX_DB_WORKERS);
}

/** The slot of the current worker (Vitest numbers them 1..maxWorkers), or undefined outside a worker. */
export function currentWorkerId(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const id = Number(env.VITEST_POOL_ID);
  return Number.isInteger(id) && id >= 1 ? id : undefined;
}

/** REMOTE_DB=1: the profile for a slow remote database (long timeouts, one worker unless told otherwise). */
export const isRemoteDb = (env: Record<string, string | undefined> = process.env) =>
  env.REMOTE_DB === '1';
