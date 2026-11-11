// Public interface of the assignments module: the ONLY file other modules (and the composition root) may import.
export { type AssignmentsController, createAssignmentsController } from './assignments.controller';
export * from './assignments.errors';
export { type AssignmentsRepository, createAssignmentsRepository } from './assignments.repository';
export { createAssignmentsRoutes } from './assignments.routes';
export {
  type AssignmentsConfig,
  type AssignmentsService,
  BLOCKED_EXTENSIONS,
  createAssignmentsService,
} from './assignments.service';
