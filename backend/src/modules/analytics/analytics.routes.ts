import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AnalyticsController } from './analytics.controller';
import * as s from './analytics.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Offering-scoped routes need only a session at the hook: the
// service puts the access CTE in the same statement as the work (404 for a non-participant, 403 without the permission).
const classView = { permission: 'progress.view_class', scope: 'offering' } as const;
const atRisk = { permission: 'atrisk.view', scope: 'offering' } as const;
const report = { permission: 'report.view' } as const;

export function createAnalyticsRoutes(deps: {
  analyticsController: AnalyticsController;
}): FastifyPluginAsyncTypebox {
  const { analyticsController: c } = deps;
  return async (app) => {
    app.get(
      '/me/dashboard',
      { config: { authenticated: true }, schema: s.learnerDashboardRouteSchema },
      c.learnerDashboard,
    );
    app.get(
      '/me/teaching/dashboard',
      { config: { authenticated: true }, schema: s.teachingDashboardRouteSchema },
      c.teachingDashboard,
    );
    app.get(
      '/offerings/:id/dashboard',
      { config: classView, schema: s.offeringDashboardRouteSchema },
      c.offeringDashboard,
    );
    app.get(
      '/offerings/:id/videos/:itemId/engagement',
      { config: classView, schema: s.videoEngagementRouteSchema },
      c.videoEngagement,
    );
    app.get('/offerings/:id/at-risk', { config: atRisk, schema: s.atRiskRouteSchema }, c.atRisk);
    app.get(
      '/offerings/:id/at-risk.csv',
      { config: atRisk, schema: s.atRiskCsvRouteSchema },
      c.atRiskCsv,
    );
    app.get(
      '/offerings/:id/at-risk.xlsx',
      { config: atRisk, schema: s.atRiskXlsxRouteSchema },
      c.atRiskXlsx,
    );

    app.get(
      '/analytics/settings',
      { config: report, schema: s.getSettingsRouteSchema },
      c.getSettings,
    );
    app.patch(
      '/analytics/settings',
      { config: { permission: 'tenant.manage' }, schema: s.updateSettingsRouteSchema },
      c.updateSettings,
    );
    app.get(
      '/reports/active-users',
      { config: report, schema: s.activeUsersRouteSchema },
      c.activeUsers,
    );
    app.get('/reports/:table', { config: report, schema: s.reportRouteSchema }, c.report);
    app.get(
      '/reports/:table/export',
      { config: report, schema: s.reportExportRouteSchema },
      c.reportExport,
    );
  };
}
