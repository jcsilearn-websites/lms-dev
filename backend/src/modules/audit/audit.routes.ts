import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AuditController } from './audit.controller';
import { listPlatformAuditRouteSchema, listTenantAuditRouteSchema } from './audit.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic.
export function createAuditRoutes(deps: {
  auditController: AuditController;
}): FastifyPluginAsyncTypebox {
  const { auditController } = deps;
  return async (app) => {
    app.get(
      '/audit',
      { config: { permission: 'audit.read' }, schema: listTenantAuditRouteSchema },
      auditController.listTenant,
    );
    app.get(
      '/platform/audit',
      { config: { permission: 'platform.audit.read' }, schema: listPlatformAuditRouteSchema },
      auditController.listPlatform,
    );
  };
}
