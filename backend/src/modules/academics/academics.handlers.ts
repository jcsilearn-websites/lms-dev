import type { HandlerMap } from '../../core/handlers';
import type { AcademicsService } from './academics.service';

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly. Nothing runs in the background for the
// academic structure.
export function createAcademicsHandlers(_deps: { academicsService: AcademicsService }): HandlerMap {
  return {};
}
