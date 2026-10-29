import type { FastifyReply, FastifyRequest } from 'fastify';
import { contextFrom } from '../../core/context';
import { ENTITIES, type Entity, type EntityKey } from './academics.entities';
import type { AcademicsService, Row } from './academics.service';

// Reads the validated request, calls the service, maps the row to the response DTO.
// No DB access, no business rules.

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** snake_case row from the database -> the API shape (camelCase; a batch also gets its label). */
export function toDto(e: Entity, row: Row): Record<string, unknown> {
  const dto: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) dto[camel(k)] = v;
  if (e.key === 'batches') dto.label = `${row.admission_year}-${row.graduation_year}`;
  return dto;
}

type Req = FastifyRequest<{
  Params: { id: string };
  Body: Record<string, unknown>;
  Querystring: Record<string, unknown>;
}>;

export function createAcademicsController(deps: { academicsService: AcademicsService }) {
  const { academicsService: svc } = deps;
  return {
    /** The seven handlers of one entity, built from its description. */
    forEntity(key: EntityKey) {
      const e = ENTITIES[key];
      return {
        list: async (request: Req) => {
          const page = await svc.list(contextFrom(request), key, request.query);
          return { items: page.items.map((r) => toDto(e, r)), nextCursor: page.nextCursor };
        },
        get: async (request: Req) =>
          toDto(e, await svc.get(contextFrom(request), key, request.params.id)),
        create: async (request: Req, reply: FastifyReply) => {
          const row = await svc.create(contextFrom(request), key, request.body);
          reply.status(201);
          return toDto(e, row);
        },
        update: async (request: Req) =>
          toDto(e, await svc.update(contextFrom(request), key, request.params.id, request.body)),
        archive: async (request: Req) =>
          toDto(e, await svc.archive(contextFrom(request), key, request.params.id)),
        unarchive: async (request: Req) =>
          toDto(e, await svc.unarchive(contextFrom(request), key, request.params.id)),
        remove: async (request: Req) => {
          await svc.remove(contextFrom(request), key, request.params.id);
          return { status: 'deleted' };
        },
      };
    },
    setCurrent: async (request: Req) =>
      toDto(
        ENTITIES['academic-years'],
        await svc.setCurrent(contextFrom(request), request.params.id),
      ),
  };
}
export type AcademicsController = ReturnType<typeof createAcademicsController>;
