// Public interface of the courses module: the ONLY file other modules (and the composition root) may import.
export {
  type AccessRow,
  type AccessSpec,
  accessCte,
  assertAccess,
} from './courses.access';
export {
  type CoursesController,
  createCoursesController,
  toOfferingDto,
} from './courses.controller';
export * from './courses.errors';
export { type CourseSyncConfig, createCoursesHandlers } from './courses.handlers';
export { type CoursesRepository, createCoursesRepository } from './courses.repository';
export {
  type CourseParticipationResolverFactory,
  createCourseParticipationResolver,
} from './courses.resolver';
export { createCoursesRoutes } from './courses.routes';
export { type CoursesService, createCoursesService } from './courses.service';
