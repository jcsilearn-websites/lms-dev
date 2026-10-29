// Public interface of the academics module: the ONLY file other modules (and the composition root) may import.
export { type AcademicsController, createAcademicsController, toDto } from './academics.controller';
export * from './academics.entities';
export * from './academics.errors';
export { createAcademicsHandlers } from './academics.handlers';
export { type AcademicsRepository, createAcademicsRepository } from './academics.repository';
export { createAcademicsRoutes } from './academics.routes';
export { type AcademicsService, createAcademicsService, type Row } from './academics.service';
