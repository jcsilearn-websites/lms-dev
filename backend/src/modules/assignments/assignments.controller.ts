import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AssignmentExtensionParamsSchema,
  AssignmentFileParamsSchema,
  AssignmentItemParamsSchema,
  AssignmentLearnerParamsSchema,
  AssignmentReleaseRequestSchema,
  AttachRubricRequestSchema,
  ExtensionInputSchema,
  GradeInputSchema,
  GradingQueueQuerySchema,
  ReplaceAttachmentsRequestSchema,
  RequestAssignmentUploadSchema,
  SubmitAssignmentRequestSchema,
  UpdateAssignmentRequestSchema,
  WaivePenaltyRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import { contentDisposition } from '../../core/storage';
import type { AssignmentsService } from './assignments.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
type Item = { Params: Static<typeof AssignmentItemParamsSchema> };
type File = { Params: Static<typeof AssignmentFileParamsSchema> };
type Learner = { Params: Static<typeof AssignmentLearnerParamsSchema> };
type Ext = { Params: Static<typeof AssignmentExtensionParamsSchema> };

export function createAssignmentsController(deps: { assignmentsService: AssignmentsService }) {
  const { assignmentsService: svc } = deps;
  return {
    // ---- the builder
    getConfig: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.config(contextFrom(request), request.params.id, request.params.itemId)),
    updateSettings: async (
      request: FastifyRequest<Item & { Body: Static<typeof UpdateAssignmentRequestSchema> }>,
    ) =>
      as<never>(
        await svc.updateSettings(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    replaceAttachments: async (
      request: FastifyRequest<Item & { Body: Static<typeof ReplaceAttachmentsRequestSchema> }>,
    ) =>
      as<never>(
        await svc.replaceAttachments(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body.fileIds,
        ),
      ),
    attachRubric: async (
      request: FastifyRequest<Item & { Body: Static<typeof AttachRubricRequestSchema> }>,
    ) =>
      as<never>(
        await svc.attachRubric(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body.rubricId,
        ),
      ),

    // ---- extensions
    extensions: async (request: FastifyRequest<Item>) =>
      as<never>(
        await svc.extensions(contextFrom(request), request.params.id, request.params.itemId),
      ),
    setExtension: async (
      request: FastifyRequest<Ext & { Body: Static<typeof ExtensionInputSchema> }>,
    ) =>
      as<never>(
        await svc.setExtension(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.participantId,
          request.body,
        ),
      ),
    removeExtension: async (request: FastifyRequest<Ext>) =>
      as<never>(
        await svc.removeExtension(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.participantId,
        ),
      ),

    // ---- the learner
    me: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.me(contextFrom(request), request.params.id, request.params.itemId)),
    requestUpload: async (
      request: FastifyRequest<Item & { Body: Static<typeof RequestAssignmentUploadSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.requestUpload(
        contextFrom(request),
        request.params.id,
        request.params.itemId,
        request.body,
      );
      return reply.code(201).send({
        fileId: r.fileId,
        upload: {
          url: r.upload.url,
          method: r.upload.method,
          headers: r.upload.headers,
          expiresAt: r.upload.expiresAt.toISOString(),
        },
        maxBytes: r.maxBytes,
      } as never);
    },
    confirmUpload: async (request: FastifyRequest<File>) =>
      as<never>(
        await svc.confirmUpload(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.fileId,
        ),
      ),
    submit: async (
      request: FastifyRequest<Item & { Body: Static<typeof SubmitAssignmentRequestSchema> }>,
    ) =>
      as<never>(
        await svc.submit(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    learnerFile: async (request: FastifyRequest<File>) =>
      as<never>(
        await svc.learnerFile(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.fileId,
        ),
      ),

    // ---- grading
    queue: async (
      request: FastifyRequest<Item & { Querystring: Static<typeof GradingQueueQuerySchema> }>,
    ) =>
      as<never>(
        await svc.queue(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.query,
        ),
      ),
    summary: async (request: FastifyRequest<Item>) =>
      as<never>(await svc.summary(contextFrom(request), request.params.id, request.params.itemId)),
    learner: async (request: FastifyRequest<Learner>) =>
      as<never>(
        await svc.learner(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.learnerKey,
        ),
      ),
    grade: async (request: FastifyRequest<Learner & { Body: Static<typeof GradeInputSchema> }>) =>
      as<never>(
        await svc.grade(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.learnerKey,
          request.body,
        ),
      ),
    waive: async (
      request: FastifyRequest<Learner & { Body: Static<typeof WaivePenaltyRequestSchema> }>,
    ) =>
      as<never>(
        await svc.setWaiver(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.learnerKey,
          { reason: request.body.reason },
        ),
      ),
    unwaive: async (request: FastifyRequest<Learner>) =>
      as<never>(
        await svc.setWaiver(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.learnerKey,
          null,
        ),
      ),
    release: async (
      request: FastifyRequest<Item & { Body: Static<typeof AssignmentReleaseRequestSchema> }>,
    ) =>
      as<never>(
        await svc.release(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body.learnerKeys,
        ),
      ),
    staffFile: async (request: FastifyRequest<File>) =>
      as<never>(
        await svc.staffFile(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.params.fileId,
        ),
      ),
    zip: async (request: FastifyRequest<Item>, reply: FastifyReply) => {
      const z = await svc.zip(contextFrom(request), request.params.id, request.params.itemId);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', contentDisposition(z.fileName, false))
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(z.stream);
    },
  };
}
export type AssignmentsController = ReturnType<typeof createAssignmentsController>;
