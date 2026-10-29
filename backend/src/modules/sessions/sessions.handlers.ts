import type { HandlerMap } from '../../core/handlers';
import type { SessionsService } from './sessions.service';

export interface PurgeConfig {
  /** Dead sessions/tokens are kept this long after they died, then deleted. */
  retentionDays: number;
  /** Rows deleted per statement: bounded so the purge never holds locks for long. */
  batchSize: number;
  everyMs: number;
}

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly.
export function createSessionsHandlers(deps: {
  sessionsService: SessionsService;
  purge: PurgeConfig;
}): HandlerMap {
  const { sessionsService, purge } = deps;
  return {
    'sessions.purge_dead': {
      everyMs: purge.everyMs,
      run: async () => ({
        deleted: await sessionsService.purgeDead({
          retentionDays: purge.retentionDays,
          batchSize: purge.batchSize,
        }),
      }),
    },
  };
}
