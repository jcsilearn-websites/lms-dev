import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { QuestionsController } from './questions.controller';
import * as s from './questions.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. `scope: 'course'`: the hook needs a session, the
// service decides from the caller's participation in ANY offering of the course (404 if none, 403 if not allowed).
const read = { permission: 'question.read', scope: 'course' } as const;
const manage = { permission: 'question.manage', scope: 'course' } as const;

export function createQuestionsRoutes(deps: {
  questionsController: QuestionsController;
}): FastifyPluginAsyncTypebox {
  const { questionsController: c } = deps;
  return async (app) => {
    app.get('/courses/:courseId/questions', { config: read, schema: s.listRouteSchema }, c.list);
    app.get(
      '/courses/:courseId/question-tags',
      { config: read, schema: s.tagsRouteSchema },
      c.tags,
    );
    app.get(
      '/courses/:courseId/questions/:questionId',
      { config: read, schema: s.getRouteSchema },
      c.get,
    );
    app.get(
      '/courses/:courseId/questions/:questionId/versions',
      { config: read, schema: s.versionsRouteSchema },
      c.versions,
    );
    app.get(
      '/courses/:courseId/questions/:questionId/files/:fileId',
      { config: read, schema: s.imageRouteSchema },
      c.image,
    );
    app.post(
      '/courses/:courseId/questions',
      { config: manage, schema: s.createRouteSchema },
      c.create,
    );
    app.put(
      '/courses/:courseId/questions/:questionId',
      { config: manage, schema: s.updateRouteSchema },
      c.update,
    );
    app.post(
      '/courses/:courseId/questions/:questionId/archive',
      { config: manage, schema: s.archiveRouteSchema },
      c.archive,
    );
    app.post(
      '/courses/:courseId/questions/:questionId/unarchive',
      { config: manage, schema: s.unarchiveRouteSchema },
      c.unarchive,
    );

    app.get(
      '/courses/:courseId/question-imports/template.csv',
      { config: manage, schema: s.templateRouteSchema },
      c.template,
    );
    app.post(
      '/courses/:courseId/question-imports',
      { config: manage, schema: s.uploadImportRouteSchema },
      c.upload,
    );
    app.get(
      '/courses/:courseId/question-imports/:importId',
      { config: manage, schema: s.getImportRouteSchema },
      c.getImport,
    );
    app.get(
      '/courses/:courseId/question-imports/:importId/rows',
      { config: manage, schema: s.importRowsRouteSchema },
      c.importRows,
    );
    app.post(
      '/courses/:courseId/question-imports/:importId/confirm',
      { config: manage, schema: s.confirmImportRouteSchema },
      c.confirmImport,
    );
    app.post(
      '/courses/:courseId/question-imports/:importId/cancel',
      { config: manage, schema: s.cancelImportRouteSchema },
      c.cancelImport,
    );
  };
}
