import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CategoriesSaveRequestSchema,
  ExportQuerySchema,
  GradebookImportParamsSchema,
  GradebookLearnerParamsSchema,
  GradebookParamsSchema,
  GradebookSettingsSchema,
  GradeScaleArchiveRequestSchema,
  GradeScaleInputSchema,
  GradeScaleListQuerySchema,
  GradeScaleParamsSchema,
  GridQuerySchema,
  ItemsSaveRequestSchema,
  MarkImportApplyRequestSchema,
  MarkImportRequestSchema,
  MarksSaveRequestSchema,
  OverrideRequestSchema,
  OverrideRevokeQuerySchema,
  QueueQuerySchema,
  ResultSchemaOk,
  ReturnRequestSchema,
  ReviewRequestSchema,
  SettingsPatchSchema,
  UnlockRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { GradebookService } from './gradebook.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
type Offering = { Params: Static<typeof GradebookParamsSchema> };
type Learner = { Params: Static<typeof GradebookLearnerParamsSchema> };
type Imp = { Params: Static<typeof GradebookImportParamsSchema> };
const ok: Static<typeof ResultSchemaOk> = { ok: true };

/** Extension in the file name is for the human: the format comes from the route. */
function contentDisposition(fileName: string): string {
  return `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
}

export function createGradebookController(deps: { gradebookService: GradebookService }) {
  const { gradebookService: svc } = deps;

  const download =
    (format: 'csv' | 'xlsx') =>
    async (
      request: FastifyRequest<Offering & { Querystring: Static<typeof ExportQuerySchema> }>,
      reply: FastifyReply,
    ) => {
      const f = await svc.exportSnapshot(
        contextFrom(request),
        request.params.id,
        request.query.version ?? null,
        format,
      );
      return reply
        .header('content-type', f.contentType)
        .header('content-disposition', contentDisposition(f.fileName))
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(f.stream);
    };

  return {
    config: async (request: FastifyRequest<Offering>) =>
      as<never>(await svc.config(contextFrom(request), request.params.id)),
    review: async (request: FastifyRequest<Offering>) =>
      as<never>(await svc.review(contextFrom(request), request.params.id)),
    updateSettings: async (
      request: FastifyRequest<Offering & { Body: Static<typeof SettingsPatchSchema> }>,
    ) => as<never>(await svc.updateSettings(contextFrom(request), request.params.id, request.body)),
    saveCategories: async (
      request: FastifyRequest<Offering & { Body: Static<typeof CategoriesSaveRequestSchema> }>,
    ) =>
      as<never>(
        await svc.saveCategories(contextFrom(request), request.params.id, request.body.categories),
      ),
    saveItems: async (
      request: FastifyRequest<Offering & { Body: Static<typeof ItemsSaveRequestSchema> }>,
    ) =>
      as<never>(await svc.saveItems(contextFrom(request), request.params.id, request.body.items)),
    grid: async (
      request: FastifyRequest<Offering & { Querystring: Static<typeof GridQuerySchema> }>,
    ) => as<never>(await svc.grid(contextFrom(request), request.params.id, request.query)),
    learner: async (request: FastifyRequest<Learner>) =>
      as<never>(
        await svc.explain(contextFrom(request), request.params.id, request.params.participantId),
      ),
    saveMarks: async (
      request: FastifyRequest<Offering & { Body: Static<typeof MarksSaveRequestSchema> }>,
    ) =>
      as<never>(await svc.saveMarks(contextFrom(request), request.params.id, request.body.cells)),

    stageImport: async (
      request: FastifyRequest<Offering & { Body: Static<typeof MarkImportRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.stageImport(contextFrom(request), request.params.id, request.body.csv);
      return reply.code(201).send(as<never>(r));
    },
    getImport: async (request: FastifyRequest<Imp>) =>
      as<never>(
        await svc.getImport(contextFrom(request), request.params.id, request.params.importId),
      ),
    applyImport: async (
      request: FastifyRequest<Imp & { Body: Static<typeof MarkImportApplyRequestSchema> }>,
    ) =>
      as<never>(
        await svc.applyImport(
          contextFrom(request),
          request.params.id,
          request.params.importId,
          request.body.skipInvalid === true,
        ),
      ),

    setOverride: async (
      request: FastifyRequest<Learner & { Body: Static<typeof OverrideRequestSchema> }>,
    ) => {
      await svc.setOverride(
        contextFrom(request),
        request.params.id,
        request.params.participantId,
        request.body,
      );
      return ok;
    },
    revokeOverride: async (
      request: FastifyRequest<Learner & { Querystring: Static<typeof OverrideRevokeQuerySchema> }>,
    ) => {
      await svc.revokeOverride(
        contextFrom(request),
        request.params.id,
        request.params.participantId,
        request.query.itemId ?? null,
      );
      return ok;
    },

    submit: async (request: FastifyRequest<Offering>) =>
      as<never>(await svc.submit(contextFrom(request), request.params.id)),
    approve: async (
      request: FastifyRequest<Offering & { Body: Static<typeof ReviewRequestSchema> }>,
    ) =>
      as<never>(
        await svc.approve(contextFrom(request), request.params.id, request.body.comment ?? null),
      ),
    returnBack: async (
      request: FastifyRequest<Offering & { Body: Static<typeof ReturnRequestSchema> }>,
    ) =>
      as<never>(
        await svc.returnToInstructor(contextFrom(request), request.params.id, request.body.comment),
      ),
    unlock: async (
      request: FastifyRequest<Offering & { Body: Static<typeof UnlockRequestSchema> }>,
    ) => as<never>(await svc.unlock(contextFrom(request), request.params.id, request.body.reason)),

    exportCsv: download('csv'),
    exportXlsx: download('xlsx'),
    me: async (request: FastifyRequest<Offering>) =>
      as<never>(await svc.me(contextFrom(request), request.params.id)),
    queue: async (request: FastifyRequest<{ Querystring: Static<typeof QueueQuerySchema> }>) =>
      as<never>(await svc.queue(contextFrom(request), request.query)),

    getCollegeSettings: async (request: FastifyRequest) =>
      as<never>(await svc.getSettings(contextFrom(request))),
    patchCollegeSettings: async (
      request: FastifyRequest<{ Body: Static<typeof GradebookSettingsSchema> }>,
    ) =>
      as<never>(
        await svc.updateCollegeSettings(contextFrom(request), request.body.allowSelfApproval),
      ),

    listScales: async (
      request: FastifyRequest<{ Querystring: Static<typeof GradeScaleListQuerySchema> }>,
    ) =>
      as<never>({
        items: await svc.listScales(contextFrom(request), request.query.includeArchived === true),
      }),
    createScale: async (
      request: FastifyRequest<{ Body: Static<typeof GradeScaleInputSchema> }>,
      reply: FastifyReply,
    ) => reply.code(201).send(as<never>(await svc.saveScale(contextFrom(request), request.body))),
    updateScale: async (
      request: FastifyRequest<{
        Params: Static<typeof GradeScaleParamsSchema>;
        Body: Static<typeof GradeScaleInputSchema>;
      }>,
    ) =>
      as<never>(
        await svc.saveScale(contextFrom(request), { ...request.body, id: request.params.scaleId }),
      ),
    archiveScale: async (
      request: FastifyRequest<{
        Params: Static<typeof GradeScaleParamsSchema>;
        Body: Static<typeof GradeScaleArchiveRequestSchema>;
      }>,
    ) =>
      as<never>(
        await svc.archiveScale(contextFrom(request), request.params.scaleId, request.body.archived),
      ),
  };
}
export type GradebookController = ReturnType<typeof createGradebookController>;
