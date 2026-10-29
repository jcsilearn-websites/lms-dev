import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { UsersController } from './users.controller';

// URL + method + TypeBox schemas + preHandlers only; no logic.
// This module has no HTTP endpoints yet (step 1b is a restructure, not a feature step).
export function createUsersRoutes(_deps: {
  usersController: UsersController;
}): FastifyPluginAsyncTypebox {
  return async () => {};
}
