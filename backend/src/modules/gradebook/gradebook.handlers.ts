import type { HandlerMap } from '../../core/handlers';
import type { GradebookService } from './gradebook.service';

// Background work of the gradebook: staged marks imports that nobody applied are removed (the staging tables are ephemeral).
export function createGradebookHandlers(deps: {
  gradebookService: GradebookService;
  purge: { everyMs: number };
}): HandlerMap {
  const { gradebookService, purge } = deps;
  return {
    'gradebook.purge_imports': {
      everyMs: purge.everyMs,
      run: async () => ({ deleted: await gradebookService.purgeImports() }),
    },
  };
}
