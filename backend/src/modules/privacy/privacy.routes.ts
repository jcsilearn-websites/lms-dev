import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { PrivacyController } from './privacy.controller';
import * as s from './privacy.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Every route is the caller's OWN data (authenticated):
// the service answers 403 for anyone who is not an active member of the college of the host.
export function createPrivacyRoutes(deps: {
  privacyController: PrivacyController;
  /** requests an hour per address (DATA_EXPORT_RATE_PER_HOUR) */
  exportRatePerHour: number;
}): FastifyPluginAsyncTypebox {
  const { privacyController: c, exportRatePerHour } = deps;
  return async (app) => {
    app.post(
      '/me/data-exports',
      {
        // the password is asked again: a hard limit across instances stops guessing through this door
        config: {
          authenticated: true,
          strictRateLimit: { max: exportRatePerHour, windowMs: 3_600_000 },
        },
        schema: s.requestExportRouteSchema,
      },
      c.requestExport,
    );
    app.get(
      '/me/data-exports',
      { config: { authenticated: true }, schema: s.listExportsRouteSchema },
      c.listExports,
    );
    app.get(
      '/me/data-exports/:id/download',
      { config: { authenticated: true }, schema: s.downloadExportRouteSchema },
      c.downloadExport,
    );
  };
}
