import type { HandlerMap } from '../../core/handlers';

// Background-job handlers for this module. None yet: progress is written by the request that reports it (one
// SECURITY DEFINER call), and the percentages are computed when they are read (indexed aggregation, see ADR 0016).
// (A handler stub, as the checklist for a new module asks.)
export function createProgressHandlers(): HandlerMap {
  return {};
}
