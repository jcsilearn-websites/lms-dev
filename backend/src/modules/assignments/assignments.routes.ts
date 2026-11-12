import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AssignmentsController } from './assignments.controller';
import * as s from './assignments.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Offering-scoped routes need only a session at the
// hook: the service (or, for the learner calls, the database function) decides who takes part and what they may do.
// The rate limit of every route here is per SESSION (core/security.ts), never per address: a lab shares one.
const build = { permission: 'assignment.manage', scope: 'offering' } as const;
const take = { permission: 'submission.create', scope: 'offering' } as const;
const grade = { permission: 'submission.grade', scope: 'offering' } as const;
const finalize = { permission: 'grade.finalize', scope: 'offering' } as const;
const A = '/offerings/:id/items/:itemId/assignment';

export function createAssignmentsRoutes(deps: {
  assignmentsController: AssignmentsController;
}): FastifyPluginAsyncTypebox {
  const { assignmentsController: c } = deps;
  return async (app) => {
    // ---- the builder (instructors)
    app.get(A, { config: build, schema: s.getConfigRouteSchema }, c.getConfig);
    app.put(A, { config: build, schema: s.updateSettingsRouteSchema }, c.updateSettings);
    app.put(
      `${A}/attachments`,
      { config: build, schema: s.replaceAttachmentsRouteSchema },
      c.replaceAttachments,
    );
    app.put(`${A}/rubric`, { config: build, schema: s.attachRubricRouteSchema }, c.attachRubric);

    // ---- extensions (sensitive: reading needs a permission assistants do not have)
    app.get(
      `${A}/extensions`,
      {
        config: { permission: 'assignment.view_extensions', scope: 'offering' },
        schema: s.listExtensionsRouteSchema,
      },
      c.extensions,
    );
    app.put(
      `${A}/extensions/:participantId`,
      { config: build, schema: s.setExtensionRouteSchema },
      c.setExtension,
    );
    app.delete(
      `${A}/extensions/:participantId`,
      { config: build, schema: s.removeExtensionRouteSchema },
      c.removeExtension,
    );

    // ---- the learner
    app.get(`${A}/me`, { config: take, schema: s.meRouteSchema }, c.me);
    app.post(
      `${A}/files`,
      {
        config: {
          ...take,
          deadline: {
            operation: 'assignment.upload',
            param: 'itemId',
            payload: s.uploadPayload,
          },
        },
        schema: s.requestUploadRouteSchema,
      },
      c.requestUpload,
    );
    app.post(
      `${A}/files/:fileId/confirm`,
      { config: take, schema: s.confirmUploadRouteSchema },
      c.confirmUpload,
    );
    app.post(
      `${A}/submissions`,
      {
        config: {
          ...take,
          deadline: {
            operation: 'assignment.submit',
            param: 'itemId',
            payload: s.handInPayload,
          },
        },
        schema: s.submitRouteSchema,
      },
      c.submit,
    );
    app.get(
      `${A}/files/:fileId`,
      { config: take, schema: s.learnerFileRouteSchema },
      c.learnerFile,
    );

    // ---- grading (instructors and assistants)
    app.get(`${A}/grading/queue`, { config: grade, schema: s.queueRouteSchema }, c.queue);
    app.get(`${A}/grading/summary`, { config: grade, schema: s.summaryRouteSchema }, c.summary);
    app.get(
      `${A}/grading/learners/:learnerKey`,
      { config: grade, schema: s.learnerRouteSchema },
      c.learner,
    );
    app.put(
      `${A}/grading/learners/:learnerKey/grade`,
      { config: grade, schema: s.gradeRouteSchema },
      c.grade,
    );
    app.get(
      `${A}/grading/files/:fileId`,
      { config: grade, schema: s.staffFileRouteSchema },
      c.staffFile,
    );
    app.get(`${A}/submissions.zip`, { config: grade, schema: s.zipRouteSchema }, c.zip);

    // ---- waiver and release (instructors)
    app.put(
      `${A}/grading/learners/:learnerKey/penalty-waiver`,
      { config: finalize, schema: s.waiveRouteSchema },
      c.waive,
    );
    app.delete(
      `${A}/grading/learners/:learnerKey/penalty-waiver`,
      { config: finalize, schema: s.unwaiveRouteSchema },
      c.unwaive,
    );
    app.post(`${A}/release`, { config: finalize, schema: s.releaseRouteSchema }, c.release);
  };
}
