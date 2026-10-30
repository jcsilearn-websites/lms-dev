import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CopyContentRequestSchema,
  CreateItemRequestSchema,
  CreateModuleRequestSchema,
  MoveItemRequestSchema,
  MoveRequestSchema,
  OfferingItemParamsSchema,
  OfferingModuleParamsSchema,
  OfferingParamsSchema,
  UpdateItemRequestSchema,
  UpdateModuleRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { ContentService, Row } from './content.service';

// Reads the validated request, calls the service, maps the row to the response DTO.
// No DB access, no business rules.
const toModuleDto = (r: Row) => ({
  id: r.id as string,
  title: r.title as string,
  published: r.published as boolean,
  availableFrom:
    r.available_from == null ? null : new Date(r.available_from as string).toISOString(),
});

/** Items arrive from SQL already shaped (camelCase JSON); only the types need to be stated. */
const toItemDto = (r: Row) => r as never;

export function createContentController(deps: { contentService: ContentService }) {
  const { contentService: svc } = deps;
  type Off = { Params: Static<typeof OfferingParamsSchema> };
  type Mod = { Params: Static<typeof OfferingModuleParamsSchema> };
  type Itm = { Params: Static<typeof OfferingItemParamsSchema> };
  return {
    outline: async (request: FastifyRequest<Off>) =>
      (await svc.outline(contextFrom(request), request.params.id)) as never,
    getItem: async (request: FastifyRequest<Itm>) =>
      toItemDto(await svc.getItem(contextFrom(request), request.params.id, request.params.itemId)),
    downloadFile: async (request: FastifyRequest<Itm>) => {
      const t = await svc.downloadFile(
        contextFrom(request),
        request.params.id,
        request.params.itemId,
      );
      return { ...t, expiresAt: t.expiresAt.toISOString() };
    },

    createModule: async (
      request: FastifyRequest<Off & { Body: Static<typeof CreateModuleRequestSchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(
          toModuleDto(
            await svc.createModule(contextFrom(request), request.params.id, request.body),
          ),
        ),
    updateModule: async (
      request: FastifyRequest<Mod & { Body: Static<typeof UpdateModuleRequestSchema> }>,
    ) =>
      toModuleDto(
        await svc.updateModule(
          contextFrom(request),
          request.params.id,
          request.params.moduleId,
          request.body,
        ),
      ),
    moveModule: async (request: FastifyRequest<Mod & { Body: Static<typeof MoveRequestSchema> }>) =>
      toModuleDto(
        await svc.moveModule(
          contextFrom(request),
          request.params.id,
          request.params.moduleId,
          request.body.after,
        ),
      ),
    deleteModule: async (request: FastifyRequest<Mod>) => {
      await svc.deleteModule(contextFrom(request), request.params.id, request.params.moduleId);
      return { status: 'deleted' };
    },

    createItem: async (
      request: FastifyRequest<Mod & { Body: Static<typeof CreateItemRequestSchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(
          toItemDto(
            await svc.createItem(
              contextFrom(request),
              request.params.id,
              request.params.moduleId,
              request.body,
            ),
          ),
        ),
    updateItem: async (
      request: FastifyRequest<Itm & { Body: Static<typeof UpdateItemRequestSchema> }>,
    ) =>
      toItemDto(
        await svc.updateItem(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    moveItem: async (
      request: FastifyRequest<Itm & { Body: Static<typeof MoveItemRequestSchema> }>,
    ) =>
      toItemDto(
        await svc.moveItem(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    deleteItem: async (request: FastifyRequest<Itm>) => {
      await svc.deleteItem(contextFrom(request), request.params.id, request.params.itemId);
      return { status: 'deleted' };
    },

    copy: async (
      request: FastifyRequest<Off & { Body: Static<typeof CopyContentRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.copyFrom(
        contextFrom(request),
        request.params.id,
        request.body.sourceOfferingId,
      );
      return reply.code(r.status === 'queued' ? 202 : 200).send(r);
    },
  };
}
export type ContentController = ReturnType<typeof createContentController>;
