import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { ProfilesController } from './profiles.controller';
import {
  getProfileRouteSchema,
  moveManyRouteSchema,
  moveOneRouteSchema,
  ownProfileRouteSchema,
  updateProfileRouteSchema,
} from './profiles.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic.
export function createProfilesRoutes(deps: {
  profilesController: ProfilesController;
}): FastifyPluginAsyncTypebox {
  const { profilesController: c } = deps;
  return async (app) => {
    app.get(
      '/members/:userId/profile',
      { config: { permission: 'profile.manage' }, schema: getProfileRouteSchema },
      c.get,
    );
    app.patch(
      '/members/:userId/profile',
      { config: { permission: 'profile.manage' }, schema: updateProfileRouteSchema },
      c.update,
    );
    app.post(
      '/members/:userId/profile/section',
      { config: { permission: 'profile.manage' }, schema: moveOneRouteSchema },
      c.moveOne,
    );
    app.post(
      '/sections/move',
      { config: { permission: 'profile.manage' }, schema: moveManyRouteSchema },
      c.moveMany,
    );
    app.get(
      '/me/profile',
      { config: { permission: 'profile.read_own' }, schema: ownProfileRouteSchema },
      c.getOwn,
    );
  };
}
