import { Readable } from 'node:stream';
import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ClassQuerySchema,
  HeartbeatRequestSchema,
  ItemProgressParamsSchema,
  LearnerParamsSchema,
  OfferingParamsSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { ClassQuery } from './progress.service';
import { decodeCursor, type ProgressService } from './progress.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.

const as = <T>(v: unknown) => v as T;

function toQuery(q: Static<typeof ClassQuerySchema>): ClassQuery {
  return {
    limit: q.limit ?? 50,
    after: decodeCursor(q.after),
    section: q.section ?? null,
    status: q.status ?? null,
    removed: q.learners === 'removed',
    sort: q.sort ?? 'name',
    dir: q.dir ?? 'asc',
  };
}

export function createProgressController(deps: { progressService: ProgressService }) {
  const { progressService: svc } = deps;
  type Item = { Params: Static<typeof ItemProgressParamsSchema> };
  type Off = {
    Params: Static<typeof OfferingParamsSchema>;
    Querystring: Static<typeof ClassQuerySchema>;
  };
  const mark =
    (action: 'viewed' | 'complete' | 'uncomplete') => async (request: FastifyRequest<Item>) =>
      as<never>(
        await svc.mark(contextFrom(request), request.params.id, request.params.itemId, action),
      );
  return {
    heartbeat: async (
      request: FastifyRequest<Item & { Body: Static<typeof HeartbeatRequestSchema> }>,
    ) =>
      as<never>(
        await svc.heartbeat(
          contextFrom(request),
          request.params.id,
          request.params.itemId,
          request.body,
        ),
      ),
    viewed: mark('viewed'),
    complete: mark('complete'),
    uncomplete: mark('uncomplete'),
    mine: async (request: FastifyRequest<{ Params: Static<typeof OfferingParamsSchema> }>) =>
      as<never>(await svc.mine(contextFrom(request), request.params.id)),
    mineEverywhere: async (request: FastifyRequest) =>
      as<never>(await svc.mineEverywhere(contextFrom(request))),
    classPage: async (request: FastifyRequest<Off>) =>
      as<never>(
        await svc.classPage(contextFrom(request), request.params.id, toQuery(request.query)),
      ),
    learner: async (request: FastifyRequest<{ Params: Static<typeof LearnerParamsSchema> }>) =>
      as<never>(
        await svc.learner(contextFrom(request), request.params.id, request.params.participantId),
      ),

    /** The CSV: the first page is fetched before anything is sent, so a refusal is a normal JSON error. */
    classCsv: async (request: FastifyRequest<Off>, reply: FastifyReply) => {
      const q = toQuery(request.query);
      const it = svc.classCsv(contextFrom(request), request.params.id, q);
      const first = await it.next();
      async function* all() {
        if (!first.done) yield first.value;
        yield* it;
      }
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="class-progress.csv"')
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store');
      return reply.send(Readable.from(all()));
    },
  };
}
export type ProgressController = ReturnType<typeof createProgressController>;
