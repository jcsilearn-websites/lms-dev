import type { HandlerMap } from '../../core/handlers';
import type { CoursesService } from './courses.service';

export interface CourseSyncConfig {
  /** Members processed per transaction. */
  batchSize: number;
  /** Batches applied at the same time (different members each). */
  concurrency: number;
  /** Safety bound for one run (the next trigger queues another job). */
  maxBatches: number;
}

// Background-job handlers for this module, run by the worker. They call the module's service only.
export function createCoursesHandlers(deps: {
  coursesService: CoursesService;
  sync: CourseSyncConfig;
}): HandlerMap {
  const { coursesService, sync } = deps;
  return {
    // Queued by the database triggers (migration 0016) for a tenant when enrolment-relevant data changes.
    'courses.sync': {
      run: async (_payload, ctx) => {
        if (!ctx.tenantId) throw new Error('courses.sync needs a tenant');
        return coursesService.syncEnrolments(ctx.tenantId, { ...sync, signal: ctx.signal });
      },
    },
  };
}
