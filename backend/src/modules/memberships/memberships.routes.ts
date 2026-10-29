import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { MembershipsController } from './memberships.controller';
import {
  changeRoleRouteSchema,
  getMemberRouteSchema,
  listMembersRouteSchema,
  reactivateMemberRouteSchema,
  removeMemberRouteSchema,
  suspendMemberRouteSchema,
} from './memberships.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. The permission here is the coarse
// check; the service re-checks and is the source of truth.
export function createMembershipsRoutes(deps: {
  membershipsController: MembershipsController;
}): FastifyPluginAsyncTypebox {
  const { membershipsController: c } = deps;
  return async (app) => {
    app.get(
      '/members',
      { config: { permission: 'member.read' }, schema: listMembersRouteSchema },
      c.list,
    );
    app.get(
      '/members/:userId',
      { config: { permission: 'member.read' }, schema: getMemberRouteSchema },
      c.get,
    );
    app.patch(
      '/members/:userId/role',
      { config: { permission: 'member.update_role' }, schema: changeRoleRouteSchema },
      c.changeRole,
    );
    app.post(
      '/members/:userId/suspend',
      { config: { permission: 'member.suspend' }, schema: suspendMemberRouteSchema },
      c.suspend,
    );
    app.post(
      '/members/:userId/reactivate',
      { config: { permission: 'member.suspend' }, schema: reactivateMemberRouteSchema },
      c.reactivate,
    );
    app.delete(
      '/members/:userId',
      { config: { permission: 'member.remove' }, schema: removeMemberRouteSchema },
      c.remove,
    );
  };
}
