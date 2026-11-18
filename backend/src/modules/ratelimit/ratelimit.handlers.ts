import type { HandlerMap } from '../../core/handlers';
import type { RateLimitService } from './ratelimit.service';

// Scheduled like the other purges: one system job per slot, however many workers run.
export function createRateLimitHandlers(deps: {
  rateLimitService: RateLimitService;
  everyMs: number;
}): HandlerMap {
  return {
    'ratelimit.purge': {
      everyMs: deps.everyMs,
      run: async () => ({ deleted: await deps.rateLimitService.purge() }),
    },
  };
}
