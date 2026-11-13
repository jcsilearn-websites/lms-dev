import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { GradebookController } from './gradebook.controller';
import * as s from './gradebook.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Offering-scoped routes need only a session at the
// hook: the service decides who takes part and what they may do (the access check is in the same statement as the work).
const read = { permission: 'gradebook.read', scope: 'offering' } as const;
const manage = { permission: 'gradebook.manage', scope: 'offering' } as const;
const marks = { permission: 'gradebook.enter_marks', scope: 'offering' } as const;
const override = { permission: 'gradebook.override', scope: 'offering' } as const;
const approve = { permission: 'gradebook.approve', scope: 'offering' } as const;
const mine = { permission: 'grade.view_own', scope: 'offering' } as const;
const G = '/offerings/:id/gradebook';

export function createGradebookRoutes(deps: {
  gradebookController: GradebookController;
}): FastifyPluginAsyncTypebox {
  const { gradebookController: c } = deps;
  return async (app) => {
    // ---- instructors and assistants
    app.get(G, { config: read, schema: s.configRouteSchema }, c.config);
    app.get(`${G}/review`, { config: read, schema: s.reviewRouteSchema }, c.review);
    app.patch(`${G}/settings`, { config: manage, schema: s.settingsRouteSchema }, c.updateSettings);
    app.put(
      `${G}/categories`,
      { config: manage, schema: s.categoriesRouteSchema },
      c.saveCategories,
    );
    app.put(`${G}/items`, { config: manage, schema: s.itemsRouteSchema }, c.saveItems);
    app.get(`${G}/grid`, { config: read, schema: s.gridRouteSchema }, c.grid);
    app.get(
      `${G}/learners/:participantId`,
      { config: read, schema: s.learnerRouteSchema },
      c.learner,
    );
    app.put(`${G}/marks`, { config: marks, schema: s.marksRouteSchema }, c.saveMarks);
    app.post(
      `${G}/mark-imports`,
      { config: marks, schema: s.importStageRouteSchema },
      c.stageImport,
    );
    app.get(
      `${G}/mark-imports/:importId`,
      { config: marks, schema: s.importGetRouteSchema },
      c.getImport,
    );
    app.post(
      `${G}/mark-imports/:importId/apply`,
      { config: marks, schema: s.importApplyRouteSchema },
      c.applyImport,
    );
    app.put(
      `${G}/learners/:participantId/override`,
      { config: override, schema: s.overrideSetRouteSchema },
      c.setOverride,
    );
    app.delete(
      `${G}/learners/:participantId/override`,
      { config: override, schema: s.overrideRevokeRouteSchema },
      c.revokeOverride,
    );
    app.post(`${G}/submit`, { config: manage, schema: s.submitRouteSchema }, c.submit);
    app.get(`${G}/export.csv`, { config: read, schema: s.exportRouteSchema }, c.exportCsv);
    app.get(`${G}/export.xlsx`, { config: read, schema: s.exportRouteSchema }, c.exportXlsx);

    // ---- the institution admin
    app.post(`${G}/approve`, { config: approve, schema: s.approveRouteSchema }, c.approve);
    app.post(`${G}/return`, { config: approve, schema: s.returnRouteSchema }, c.returnBack);
    app.post(`${G}/unlock`, { config: approve, schema: s.unlockRouteSchema }, c.unlock);
    app.get(
      '/gradebook/queue',
      { config: { permission: 'gradebook.approve' }, schema: s.queueRouteSchema },
      c.queue,
    );
    app.get(
      '/gradebook/settings',
      { config: { permission: 'gradebook.approve' }, schema: s.collegeSettingsGetRouteSchema },
      c.getCollegeSettings,
    );
    app.patch(
      '/gradebook/settings',
      { config: { permission: 'tenant.manage' }, schema: s.collegeSettingsPatchRouteSchema },
      c.patchCollegeSettings,
    );

    // ---- grade scales (every signed-in member may read the names and bands: a scale holds no personal data)
    app.get(
      '/grade-scales',
      { config: { authenticated: true }, schema: s.scalesListRouteSchema },
      c.listScales,
    );
    app.post(
      '/grade-scales',
      { config: { permission: 'gradescale.manage' }, schema: s.scaleCreateRouteSchema },
      c.createScale,
    );
    app.put(
      '/grade-scales/:scaleId',
      { config: { permission: 'gradescale.manage' }, schema: s.scaleUpdateRouteSchema },
      c.updateScale,
    );
    app.patch(
      '/grade-scales/:scaleId',
      { config: { permission: 'gradescale.manage' }, schema: s.scaleArchiveRouteSchema },
      c.archiveScale,
    );

    // ---- the learner
    app.get('/offerings/:id/me/grades', { config: mine, schema: s.meRouteSchema }, c.me);
  };
}
