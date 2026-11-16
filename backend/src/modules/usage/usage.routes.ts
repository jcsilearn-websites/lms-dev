import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { UsageController } from './usage.controller';
import * as s from './usage.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Platform permission: admin host only.
export function createUsageRoutes(deps: {
  usageController: UsageController;
}): FastifyPluginAsyncTypebox {
  const { usageController: c } = deps;
  return async (app) => {
    app.get(
      '/platform/usage',
      { config: { permission: 'platform.usage.read' }, schema: s.usageRouteSchema },
      c.list,
    );
    app.get(
      '/platform/usage/export',
      { config: { permission: 'platform.usage.read' }, schema: s.usageExportRouteSchema },
      c.export,
    );
  };
}
