import type { Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type {
  AccommodationInputSchema,
  AccommodationParamsSchema,
  AssessmentItemParamsSchema,
  AttemptFileParamsSchema,
  AttemptListQuerySchema,
  AttemptParamsSchema,
  AttemptQuestionParamsSchema,
  FeedbackRequestSchema,
  GradeRequestSchema,
  GradingAnswersQuerySchema,
  RegradeRequestSchema,
  ReleaseRequestSchema,
  ReplaceSlotsRequestSchema,
  SaveRequestSchema,
  UpdateSettingsRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { AssessmentsService } from './assessments.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
type Item = { Params: Static<typeof AssessmentItemParamsSchema> };
type Attempt = { Params: Static<typeof AttemptParamsSchema> };

export function createAssessmentsController(deps: { assessmentsService: AssessmentsService }) {
  const { assessmentsService: svc } = deps;
  return {
    getConfig: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.config(contextFrom(request), request.params.id, request.params.itemId)),
    updateSettings: async (
      request: FastifyRequest<Item & { Body: Static<typeof UpdateSettingsRequestSchema> }>,
    ) =>
      as<never>(
        await svc.updateSettings(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    replaceSlots: async (
      request: FastifyRequest<Item & { Body: Static<typeof ReplaceSlotsRequestSchema> }>,
    ) =>
      as<never>(
        await svc.replaceSlots(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body.slots,
        ),
      ),
    preview: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.preview(contextFrom(request), request.params.id, request.params.itemId)),

    accommodations: async (request: FastifyRequest<Item>) =>
      as<never>(
        await svc.accommodations(contextFrom(request), request.params.id, request.params.itemId),
      ),
    setAccommodation: async (
      request: FastifyRequest<{
        Params: Static<typeof AccommodationParamsSchema>;
        Body: Static<typeof AccommodationInputSchema>;
      }>,
    ) =>
      as<never>(
        await svc.setAccommodation(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.participantId,
          request.body,
        ),
      ),
    removeAccommodation: async (
      request: FastifyRequest<{ Params: Static<typeof AccommodationParamsSchema> }>,
    ) => {
      await svc.removeAccommodation(
        contextFrom(request),
        request.params.id,
        request.params.itemId,
        request.params.participantId,
      );
      return { status: 'ok' };
    },

    me: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.me(contextFrom(request), request.params.id, request.params.itemId)),
    start: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.start(contextFrom(request), request.params.id, request.params.itemId)),
    readAttempt: async (request: FastifyRequest<Attempt>) =>
      as<never>(
        await svc.readAttempt(contextFrom(request), request.params.id, request.params.attemptId),
      ),
    save: async (request: FastifyRequest<Attempt & { Body: Static<typeof SaveRequestSchema> }>) =>
      as<never>(
        await svc.save(
          contextFrom(request),
          request.params.id,
          request.params.attemptId,
          request.body,
        ),
      ),
    submit: async (request: FastifyRequest<Attempt>) =>
      as<never>(
        await svc.submit(contextFrom(request), request.params.id, request.params.attemptId),
      ),
    result: async (request: FastifyRequest<Attempt>) =>
      as<never>(
        await svc.result(contextFrom(request), request.params.id, request.params.attemptId),
      ),
    attemptImage: async (
      request: FastifyRequest<{ Params: Static<typeof AttemptFileParamsSchema> }>,
    ) => {
      const t = await svc.attemptImage(
        contextFrom(request),
        request.params.id,
        request.params.attemptId,
        request.params.fileId,
      );
      return as<never>({
        url: t.url,
        expiresAt: t.expiresAt,
        fileName: t.fileName,
        inline: t.inline,
      });
    },

    attempts: async (
      request: FastifyRequest<Item & { Querystring: Static<typeof AttemptListQuerySchema> }>,
    ) =>
      as<never>(
        await svc.attempts(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.query,
        ),
      ),
    gradingSummary: async (request: FastifyRequest<Item>) =>
      as<never>(
        await svc.gradingSummary(contextFrom(request), request.params.id, request.params.itemId),
      ),
    gradingAnswers: async (
      request: FastifyRequest<Item & { Querystring: Static<typeof GradingAnswersQuerySchema> }>,
    ) =>
      as<never>(
        await svc.gradingAnswers(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.query,
        ),
      ),
    script: async (request: FastifyRequest<Attempt>) =>
      as<never>(
        await svc.script(contextFrom(request), request.params.id, request.params.attemptId),
      ),
    grade: async (
      request: FastifyRequest<{
        Params: Static<typeof AttemptQuestionParamsSchema>;
        Body: Static<typeof GradeRequestSchema>;
      }>,
    ) =>
      as<never>(
        await svc.grade(
          contextFrom(request),
          request.params.id,
          request.params.attemptId,
          request.params.position,
          request.body,
        ),
      ),
    feedback: async (
      request: FastifyRequest<Attempt & { Body: Static<typeof FeedbackRequestSchema> }>,
    ) => {
      await svc.setFeedback(
        contextFrom(request),
        request.params.id,
        request.params.attemptId,
        request.body.feedback,
      );
      return { status: 'ok' };
    },
    regrade: async (
      request: FastifyRequest<Item & { Body: Static<typeof RegradeRequestSchema> }>,
    ) =>
      as<never>(
        await svc.regrade(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    regrades: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.regrades(contextFrom(request), request.params.id, request.params.itemId)),
    release: async (
      request: FastifyRequest<Item & { Body: Static<typeof ReleaseRequestSchema> }>,
    ) =>
      as<never>(
        await svc.release(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body?.attemptIds,
        ),
      ),
    analysis: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.analysis(contextFrom(request), request.params.id, request.params.itemId)),
  };
}
export type AssessmentsController = ReturnType<typeof createAssessmentsController>;
