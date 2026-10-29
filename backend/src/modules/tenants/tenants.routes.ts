import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { TenantsController } from './tenants.controller';
import {
  adminInviteRouteSchema,
  createTenantRouteSchema,
  getTenantRouteSchema,
  listTenantsRouteSchema,
  reactivateTenantRouteSchema,
  suspendTenantRouteSchema,
  tenantMembersRouteSchema,
  updateTenantRouteSchema,
} from './tenants.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. All of these are platform-admin
// endpoints: the permission is only ever granted on the admin host.
export function createTenantsRoutes(deps: {
  tenantsController: TenantsController;
}): FastifyPluginAsyncTypebox {
  const { tenantsController: c } = deps;
  return async (app) => {
    app.post(
      '/platform/tenants',
      { config: { permission: 'platform.tenant.manage' }, schema: createTenantRouteSchema },
      c.create,
    );
    app.get(
      '/platform/tenants',
      { config: { permission: 'platform.tenant.read' }, schema: listTenantsRouteSchema },
      c.list,
    );
    app.get(
      '/platform/tenants/:id',
      { config: { permission: 'platform.tenant.read' }, schema: getTenantRouteSchema },
      c.get,
    );
    app.patch(
      '/platform/tenants/:id',
      { config: { permission: 'platform.tenant.manage' }, schema: updateTenantRouteSchema },
      c.update,
    );
    app.post(
      '/platform/tenants/:id/suspend',
      { config: { permission: 'platform.tenant.manage' }, schema: suspendTenantRouteSchema },
      c.suspend,
    );
    app.post(
      '/platform/tenants/:id/reactivate',
      { config: { permission: 'platform.tenant.manage' }, schema: reactivateTenantRouteSchema },
      c.reactivate,
    );
    app.post(
      '/platform/tenants/:id/admin-invite',
      { config: { permission: 'platform.tenant.manage' }, schema: adminInviteRouteSchema },
      c.inviteAdmin,
    );
    app.get(
      '/platform/tenants/:id/members',
      { config: { permission: 'platform.tenant.read' }, schema: tenantMembersRouteSchema },
      c.members,
    );
  };
}
