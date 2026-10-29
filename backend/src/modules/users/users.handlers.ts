import type { HandlerMap } from '../../core/handlers';
import type { UsersService } from './users.service';

// Background-job and domain-event handlers for this module, run by the worker (src/worker.ts).
// They call the module's service, never the repository or the database directly.
// No jobs or events exist yet, so the map is empty.
export function createUsersHandlers(_deps: { usersService: UsersService }): HandlerMap {
  return {};
}
