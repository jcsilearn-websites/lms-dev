import type { HandlerMap } from '../../core/handlers';
import type { AnalyticsService } from './analytics.service';

// Background jobs of this module. The rollup refresh is a scheduled system job (one per time slot across all workers): it
// recomputes only what the change marks say changed, in bounded batches, and is safe to run twice.
export function createAnalyticsHandlers(deps: {
  analyticsService: AnalyticsService;
  refresh: { everyMs: number };
}): HandlerMap {
  const { analyticsService, refresh } = deps;
  return {
    'analytics.rollup': {
      everyMs: refresh.everyMs,
      run: async (_payload, ctx) => {
        const r = await analyticsService.refreshRollups({ signal: ctx.signal });
        return { tenants: r.tenants, batches: r.batches, remaining: r.remaining };
      },
    },
  };
}
