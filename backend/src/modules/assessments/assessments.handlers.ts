import type { HandlerMap } from '../../core/handlers';
import type { AssessmentsService } from './assessments.service';

// Background-job handlers for this module, run by the worker. They call the module's service only.
export function createAssessmentsHandlers(deps: {
  assessmentsService: AssessmentsService;
  sweep: { everyMs: number };
}): HandlerMap {
  const { assessmentsService, sweep } = deps;
  return {
    // Auto-submit: closes every attempt whose server deadline (plus the save grace) has passed, even when the
    // browser is closed, so no attempt stays open and its answers are scored. Several workers share the work
    // (SKIP LOCKED in the database function); an attempt is closed exactly once.
    'assessments.sweep': {
      everyMs: sweep.everyMs,
      run: async (_payload, ctx) => ({ closed: await assessmentsService.sweep(ctx.signal) }),
    },
  };
}
