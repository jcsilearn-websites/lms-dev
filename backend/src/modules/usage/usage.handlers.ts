import type { HandlerMap } from '../../core/handlers';
import type { UsageService } from './usage.service';

// A scheduled system job: freezes the months that ended. Idempotent (ON CONFLICT DO NOTHING + an append-only table).
export function createUsageHandlers(deps: {
  usageService: UsageService;
  close: { everyMs: number };
}): HandlerMap {
  return {
    'usage.close_months': {
      everyMs: deps.close.everyMs,
      run: async () => ({ closed: await deps.usageService.closeDueMonths() }),
    },
  };
}
