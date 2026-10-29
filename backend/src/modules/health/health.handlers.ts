import type { HandlerMap } from '../../core/handlers';
import type { HealthService } from './health.service';

// Background-job and domain-event handlers for this module, run by the worker (src/worker.ts).
// Nothing to run in the background for health. They call the module's service, never the repository or the database directly.
// No jobs or events exist yet, so the map is empty.
export function createHealthHandlers(_deps: { healthService: HealthService }): HandlerMap {
  return {};
}
