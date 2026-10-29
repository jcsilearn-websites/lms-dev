import type { HealthService } from './health.service';

export function createHealthController(deps: { healthService: HealthService }) {
  const { healthService } = deps;
  return {
    live: async () => {
      healthService.live();
      return { status: 'ok' as const };
    },
    ready: async () => {
      await healthService.ready();
      return { status: 'ok' as const, db: 'up' as const };
    },
  };
}
export type HealthController = ReturnType<typeof createHealthController>;
