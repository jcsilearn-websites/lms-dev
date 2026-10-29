import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { HealthController } from './health.controller';
import { liveRouteSchema, readyRouteSchema } from './health.schemas';

// URL + method + schemas only. Probes are exempt from rate limiting.
export function createHealthRoutes(deps: {
  healthController: HealthController;
}): FastifyPluginAsyncTypebox {
  const { healthController } = deps;
  return async (app) => {
    app.get(
      '/health/live',
      { config: { public: true, rateLimit: false }, schema: liveRouteSchema },
      healthController.live,
    );
    app.get(
      '/health/ready',
      { config: { public: true, rateLimit: false }, schema: readyRouteSchema },
      healthController.ready,
    );
  };
}
