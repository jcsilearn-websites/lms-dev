// Public interface of the analytics module: the ONLY file other modules (and the composition root) may import.
export { type AnalyticsController, createAnalyticsController } from './analytics.controller';
export * from './analytics.errors';
export { createAnalyticsHandlers } from './analytics.handlers';
export { type AnalyticsRepository, createAnalyticsRepository } from './analytics.repository';
export { createAnalyticsRoutes } from './analytics.routes';
export { type AnalyticsService, createAnalyticsService } from './analytics.service';
