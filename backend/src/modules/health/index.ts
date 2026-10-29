// Public interface of the health module: the ONLY file other modules (and the composition root) may import.
export { createHealthController, type HealthController } from './health.controller';
export * from './health.errors';
export { createHealthHandlers } from './health.handlers';
export { createHealthRepository, type HealthRepository } from './health.repository';
export { createHealthRoutes } from './health.routes';
export { createHealthService, type HealthService } from './health.service';
