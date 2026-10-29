import { NotReadyError } from './health.errors';
import type { HealthRepository } from './health.repository';

export function createHealthService(deps: {
  healthRepo: HealthRepository;
  readyTimeoutMs: number;
}) {
  const { healthRepo, readyTimeoutMs } = deps;
  return {
    /** Liveness never touches the database. */
    live: () => ({ alive: true as const }),

    /** Throws NotReadyError (503) when the database cannot answer within the timeout. */
    async ready(): Promise<void> {
      try {
        await healthRepo.pingDatabase(readyTimeoutMs);
      } catch (cause) {
        throw new NotReadyError({ cause });
      }
    },
  };
}
export type HealthService = ReturnType<typeof createHealthService>;
