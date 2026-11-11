// Public interface of the rubrics module: the ONLY file other modules (and the composition root) may import.
export { createRubricsController, type RubricsController } from './rubrics.controller';
export * from './rubrics.errors';
export { createRubricsRepository, type RubricsRepository } from './rubrics.repository';
export { createRubricsRoutes } from './rubrics.routes';
export { createRubricsService, type RubricsService } from './rubrics.service';
