// Public interface of the questions module: the ONLY file other modules (and the composition root) may import.
export { createQuestionsController, type QuestionsController } from './questions.controller';
export * from './questions.errors';
export { createQuestionsHandlers } from './questions.handlers';
export { createQuestionsRepository, type QuestionsRepository } from './questions.repository';
export { createQuestionsRoutes } from './questions.routes';
export { createQuestionsService, type QuestionsService } from './questions.service';
