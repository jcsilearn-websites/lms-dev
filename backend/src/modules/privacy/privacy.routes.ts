import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { ErasureController, PrivacyController } from './privacy.controller';
import * as s from './privacy.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Every route is the caller's OWN data (authenticated):
// the service answers 403 for anyone who is not an active member of the college of the host.
export function createPrivacyRoutes(deps: {
  privacyController: PrivacyController;
  erasureController: ErasureController;
  /** requests an hour per address (DATA_EXPORT_RATE_PER_HOUR) */
  exportRatePerHour: number;
}): FastifyPluginAsyncTypebox {
  const { privacyController: c, erasureController: e, exportRatePerHour } = deps;
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

    // ---- erasure inside a college: the member's own routes, then the administrators'
    app.get(
      '/me/erasure/preview',
      { config: { authenticated: true }, schema: s.erasurePreviewRouteSchema },
      e.preview,
    );
    app.get(
      '/me/erasure',
      { config: { authenticated: true }, schema: s.myErasureRouteSchema },
      e.mine,
    );
    app.post(
      '/me/erasure',
      {
        // the password is asked again: a hard limit across instances stops guessing through this door
        config: {
          authenticated: true,
          strictRateLimit: { max: exportRatePerHour, windowMs: 3_600_000 },
        },
        schema: s.requestErasureRouteSchema,
      },
      e.request,
    );
    app.post(
      '/me/erasure/cancel',
      { config: { authenticated: true }, schema: s.cancelMyErasureRouteSchema },
      e.cancelMine,
    );
    // ---- erasure of the whole account: the member of exactly one college (combined), then the platform administrators' path
    app.get(
      '/me/account-erasure',
      { config: { authenticated: true }, schema: s.myAccountErasureRouteSchema },
      e.accountMine,
    );
    app.post(
      '/me/account-erasure',
      {
        // the password is asked again: a hard limit across instances stops guessing through this door
        config: {
          authenticated: true,
          strictRateLimit: { max: exportRatePerHour, windowMs: 3_600_000 },
        },
        schema: s.requestAccountErasureRouteSchema,
      },
      e.requestAccount,
    );
    const platform = { permission: 'platform.account_erasure.manage' } as const;
    const platformWrite = { ...platform, stepUp: true } as const;
    app.get(
      '/platform/account-erasures',
      { config: platform, schema: s.platformAccountErasureListRouteSchema },
      e.platformList,
    );
    app.post(
      '/platform/account-erasures',
      { config: platformWrite, schema: s.platformAccountErasureRequestRouteSchema },
      e.platformRequest,
    );
    app.post(
      '/platform/account-erasures/:id/approve',
      { config: platformWrite, schema: s.approveAccountErasureRouteSchema },
      e.platformDecide('approve'),
    );
    app.post(
      '/platform/account-erasures/:id/reject',
      { config: platformWrite, schema: s.rejectAccountErasureRouteSchema },
      e.platformDecide('reject'),
    );
    app.post(
      '/platform/account-erasures/:id/cancel',
      { config: platformWrite, schema: s.cancelAccountErasureRouteSchema },
      e.platformDecide('cancel'),
    );
    const approve = { permission: 'privacy.erasure.approve' } as const;
    const decide = { ...approve, stepUp: true } as const;
    app.get(
      '/privacy/erasure-requests',
      { config: approve, schema: s.erasureAdminListRouteSchema },
      e.adminList,
    );
    app.post(
      '/privacy/erasure-requests/:id/approve',
      { config: decide, schema: s.approveErasureRouteSchema },
      e.decide('approve'),
    );
    app.post(
      '/privacy/erasure-requests/:id/reject',
      { config: decide, schema: s.rejectErasureRouteSchema },
      e.decide('reject'),
    );
    app.post(
      '/privacy/erasure-requests/:id/cancel',
      { config: decide, schema: s.cancelErasureRouteSchema },
      e.decide('cancel'),
    );
  };
}
