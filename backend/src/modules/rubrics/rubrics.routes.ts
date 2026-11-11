import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { RubricsController } from './rubrics.controller';
import * as s from './rubrics.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. `scope: 'course'`: the hook needs a session, the
// service decides from the caller's participation in ANY offering of the course (404 if none, 403 if not allowed).
const read = { permission: 'rubric.read', scope: 'course' } as const;
const manage = { permission: 'rubric.manage', scope: 'course' } as const;

export function createRubricsRoutes(deps: {
  rubricsController: RubricsController;
}): FastifyPluginAsyncTypebox {
  const { rubricsController: c } = deps;
  return async (app) => {
    app.get('/courses/:courseId/rubrics', { config: read, schema: s.listRouteSchema }, c.list);
    app.get(
      '/courses/:courseId/rubrics/:rubricId',
      { config: read, schema: s.getRouteSchema },
      c.get,
    );
    app.post(
      '/courses/:courseId/rubrics',
      { config: manage, schema: s.createRouteSchema },
      c.create,
    );
    app.put(
      '/courses/:courseId/rubrics/:rubricId',
      { config: manage, schema: s.updateRouteSchema },
      c.update,
    );
    app.patch(
      '/courses/:courseId/rubrics/:rubricId',
      { config: manage, schema: s.archiveRouteSchema },
      c.archive,
    );
  };
}
