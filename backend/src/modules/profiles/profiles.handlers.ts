import type { HandlerMap } from '../../core/handlers';
import type { ProfilesService } from './profiles.service';

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly. Nothing runs in the background for profiles.
export function createProfilesHandlers(_deps: { profilesService: ProfilesService }): HandlerMap {
  return {};
}
