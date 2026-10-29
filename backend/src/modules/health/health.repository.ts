import type { Database } from '../../db/client';

// Not tenant data: readiness talks to the pool directly, with no tenant context.
export function createHealthRepository(deps: { db: Pick<Database, 'ping'> }) {
  return {
    pingDatabase: (timeoutMs: number) => deps.db.ping(timeoutMs),
  };
}
export type HealthRepository = ReturnType<typeof createHealthRepository>;
