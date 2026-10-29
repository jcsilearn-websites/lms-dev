import type { HandlerMap } from '../../core/handlers';
import type { JobsService } from './jobs.service';

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly.
export function createJobsHandlers(deps: {
  jobsService: JobsService;
  purge: { everyMs: number };
}): HandlerMap {
  const { jobsService, purge } = deps;
  return {
    // completed jobs after JOBS_COMPLETED_RETENTION_DAYS, dead ones after JOBS_DEAD_RETENTION_DAYS;
    // scheduled like the other purges and run by the queue itself
    'jobs.purge': {
      everyMs: purge.everyMs,
      run: async () => ({ deleted: await jobsService.purgeFinished() }),
    },
  };
}
