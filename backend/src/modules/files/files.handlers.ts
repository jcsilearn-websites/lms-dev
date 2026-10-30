import type { HandlerMap } from '../../core/handlers';
import type { FilesService } from './files.service';

// Background-job handlers for this module, run by the worker. They call the module's service only.
export function createFilesHandlers(deps: {
  filesService: FilesService;
  purge: { everyMs: number };
}): HandlerMap {
  const { filesService, purge } = deps;
  return {
    // Deletes files nothing references, once they are past the grace period (FILE_PURGE_GRACE_HOURS).
    'files.purge': {
      everyMs: purge.everyMs,
      run: async () => ({ deleted: await filesService.purgeUnreferenced() }),
    },
  };
}
