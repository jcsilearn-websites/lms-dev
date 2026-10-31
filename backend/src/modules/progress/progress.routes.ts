import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { ProgressController } from './progress.controller';
import * as s from './progress.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Offering-scoped routes need only a session at the
// hook: the service (or, for the writes, the database function) decides who takes part and what they may do.
const record = { permission: 'progress.record', scope: 'offering' } as const;
const classView = { permission: 'progress.view_class', scope: 'offering' } as const;

export function createProgressRoutes(deps: {
  progressController: ProgressController;
}): FastifyPluginAsyncTypebox {
  const { progressController: c } = deps;
  return async (app) => {
    app.post(
      '/offerings/:id/items/:itemId/progress/heartbeat',
      {
        // a player sends one every 30 s and on pause / seek / hide: generous, per IP
        config: { ...record, rateLimit: { max: 6000, timeWindow: '1 minute' } },
        schema: s.heartbeatRouteSchema,
      },
      c.heartbeat,
    );
    app.post(
      '/offerings/:id/items/:itemId/progress/viewed',
      { config: record, schema: s.viewedRouteSchema },
      c.viewed,
    );
    app.post(
      '/offerings/:id/items/:itemId/progress/complete',
      { config: record, schema: s.completeRouteSchema },
      c.complete,
    );
    app.delete(
      '/offerings/:id/items/:itemId/progress/complete',
      { config: record, schema: s.uncompleteRouteSchema },
      c.uncomplete,
    );

    app.get(
      '/offerings/:id/progress',
      { config: { permission: 'content.view', scope: 'offering' }, schema: s.mineRouteSchema },
      c.mine,
    );
    app.get(
      '/me/progress',
      { config: { authenticated: true }, schema: s.mineEverywhereRouteSchema },
      c.mineEverywhere,
    );
    app.get(
      '/offerings/:id/progress/class',
      { config: classView, schema: s.classRouteSchema },
      c.classPage,
    );
    app.get(
      '/offerings/:id/progress/class.csv',
      { config: classView, schema: s.classCsvRouteSchema },
      c.classCsv,
    );
    app.get(
      '/offerings/:id/progress/learners/:participantId',
      { config: classView, schema: s.learnerRouteSchema },
      c.learner,
    );
  };
}
