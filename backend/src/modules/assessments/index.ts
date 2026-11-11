// Public interface of the assessments module: the ONLY file other modules (and the composition root) may import.
export { type AssessmentsController, createAssessmentsController } from './assessments.controller';
export * from './assessments.errors';
export { createAssessmentsHandlers } from './assessments.handlers';
export { type AssessmentsRepository, createAssessmentsRepository } from './assessments.repository';
export { createAssessmentsRoutes } from './assessments.routes';
export {
  type AssessmentsConfig,
  type AssessmentsService,
  createAssessmentsService,
} from './assessments.service';
