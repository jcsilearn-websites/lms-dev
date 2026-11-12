import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AssessmentsController } from './assessments.controller';
import * as s from './assessments.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Offering-scoped routes need only a session at the
// hook: the service (or, for the learner calls, the database function) decides who takes part and what they may do.
const build = { permission: 'assessment.create', scope: 'offering' } as const;
const take = { permission: 'submission.create', scope: 'offering' } as const;
const mine = { permission: 'grade.view_own', scope: 'offering' } as const;
const grade = { permission: 'submission.grade', scope: 'offering' } as const;
const finalize = { permission: 'grade.finalize', scope: 'offering' } as const;
const A = '/offerings/:id/items/:itemId/assessment';

export function createAssessmentsRoutes(deps: {
  assessmentsController: AssessmentsController;
}): FastifyPluginAsyncTypebox {
  const { assessmentsController: c } = deps;
  return async (app) => {
    // ---- the builder (instructors)
    app.get(A, { config: build, schema: s.getConfigRouteSchema }, c.getConfig);
    app.put(A, { config: build, schema: s.updateSettingsRouteSchema }, c.updateSettings);
    app.put(`${A}/slots`, { config: build, schema: s.replaceSlotsRouteSchema }, c.replaceSlots);
    app.get(`${A}/preview`, { config: build, schema: s.previewRouteSchema }, c.preview);

    // ---- accommodations (sensitive: reading needs a permission assistants do not have)
    app.get(
      `${A}/accommodations`,
      {
        config: { permission: 'assessment.view_accommodations', scope: 'offering' },
        schema: s.listAccommodationsRouteSchema,
      },
      c.accommodations,
    );
    app.put(
      `${A}/accommodations/:participantId`,
      { config: build, schema: s.setAccommodationRouteSchema },
      c.setAccommodation,
    );
    app.delete(
      `${A}/accommodations/:participantId`,
      { config: build, schema: s.removeAccommodationRouteSchema },
      c.removeAccommodation,
    );

    // ---- the learner
    app.get(`${A}/me`, { config: take, schema: s.meRouteSchema }, c.me);
    app.post(
      '/offerings/:id/items/:itemId/attempts',
      { config: take, schema: s.startRouteSchema },
      c.start,
    );
    app.get(
      '/offerings/:id/attempts/:attemptId',
      { config: take, schema: s.readAttemptRouteSchema },
      c.readAttempt,
    );
    app.put(
      '/offerings/:id/attempts/:attemptId/answers',
      {
        // per SESSION (never per address: a college lab shares one): a learner saves every few seconds, bursts on reconnect
        config: {
          ...take,
          rateLimit: { max: 900, timeWindow: '1 minute' },
          deadline: { operation: 'attempt.save', param: 'attemptId' },
        },
        schema: s.saveRouteSchema,
      },
      c.save,
    );
    app.post(
      '/offerings/:id/attempts/:attemptId/submit',
      {
        config: { ...take, deadline: { operation: 'attempt.submit', param: 'attemptId' } },
        schema: s.submitRouteSchema,
      },
      c.submit,
    );
    app.get(
      '/offerings/:id/attempts/:attemptId/result',
      { config: mine, schema: s.resultRouteSchema },
      c.result,
    );
    app.get(
      '/offerings/:id/attempts/:attemptId/files/:fileId',
      { config: take, schema: s.attemptImageRouteSchema },
      c.attemptImage,
    );

    // ---- grading (instructors and assistants)
    app.get(`${A}/attempts`, { config: grade, schema: s.listAttemptsRouteSchema }, c.attempts);
    app.get(
      `${A}/grading/summary`,
      { config: grade, schema: s.gradingSummaryRouteSchema },
      c.gradingSummary,
    );
    app.get(
      `${A}/grading/answers`,
      { config: grade, schema: s.gradingAnswersRouteSchema },
      c.gradingAnswers,
    );
    app.get(
      '/offerings/:id/attempts/:attemptId/grading',
      { config: grade, schema: s.scriptRouteSchema },
      c.script,
    );
    app.put(
      '/offerings/:id/attempts/:attemptId/questions/:position/grade',
      { config: grade, schema: s.gradeRouteSchema },
      c.grade,
    );
    app.put(
      '/offerings/:id/attempts/:attemptId/feedback',
      { config: grade, schema: s.feedbackRouteSchema },
      c.feedback,
    );

    // ---- regrade, release, analysis
    app.post(`${A}/regrade`, { config: finalize, schema: s.regradeRouteSchema }, c.regrade);
    app.get(`${A}/regrades`, { config: finalize, schema: s.regradesRouteSchema }, c.regrades);
    app.post(`${A}/release`, { config: finalize, schema: s.releaseRouteSchema }, c.release);
    app.get(
      `${A}/analysis`,
      {
        config: { permission: 'assessment.analyze', scope: 'offering' },
        schema: s.analysisRouteSchema,
      },
      c.analysis,
    );
  };
}
