import type { HandlerMap } from '../../core/handlers';
import type { QuestionsService } from './questions.service';

// Background-job handlers for this module, run by the worker. They call the module's service only.
export function createQuestionsHandlers(deps: {
  questionsService: QuestionsService;
  purge: { everyMs: number };
}): HandlerMap {
  const { questionsService, purge } = deps;
  return {
    // A CSV import that was uploaded and never confirmed is thrown away after a day.
    'questions.purge_imports': {
      everyMs: purge.everyMs,
      run: async () => ({ purged: await questionsService.purgeImports() }),
    },
  };
}
