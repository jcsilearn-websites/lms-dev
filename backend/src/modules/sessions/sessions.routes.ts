import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { SessionsController } from './sessions.controller';
import { listSessionsRouteSchema, revokeSessionRouteSchema } from './sessions.schemas';

// URL + method + schemas + preHandlers only; no logic.
export function createSessionsRoutes(deps: {
  sessionsController: SessionsController;
}): FastifyPluginAsyncTypebox {
  const { sessionsController } = deps;
  return async (app) => {
    app.get(
      '/auth/sessions',
      { config: { authenticated: true }, schema: listSessionsRouteSchema },
      sessionsController.list,
    );
    app.delete(
      '/auth/sessions/:id',
      { config: { authenticated: true }, schema: revokeSessionRouteSchema },
      sessionsController.revoke,
    );
  };
}
