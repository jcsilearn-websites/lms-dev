import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  RubricArchiveRequestSchema,
  RubricCourseParamsSchema,
  RubricInputSchema,
  RubricListQuerySchema,
  RubricParamsSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { RubricsService } from './rubrics.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
type Course = { Params: Static<typeof RubricCourseParamsSchema> };
type One = { Params: Static<typeof RubricParamsSchema> };

export function createRubricsController(deps: { rubricsService: RubricsService }) {
  const { rubricsService: svc } = deps;
  return {
    list: async (
      request: FastifyRequest<Course & { Querystring: Static<typeof RubricListQuerySchema> }>,
    ) => as<never>(await svc.list(contextFrom(request), request.params.courseId, request.query)),
    get: async (request: FastifyRequest<One>) =>
      as<never>(
        await svc.get(contextFrom(request), request.params.courseId, request.params.rubricId),
      ),
    create: async (
      request: FastifyRequest<Course & { Body: Static<typeof RubricInputSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.create(contextFrom(request), request.params.courseId, request.body);
      return reply.code(201).send(as<never>(r));
    },
    update: async (request: FastifyRequest<One & { Body: Static<typeof RubricInputSchema> }>) =>
      as<never>(
        await svc.update(
          contextFrom(request),
          request.params.courseId,
          request.params.rubricId,
          request.body,
        ),
      ),
    archive: async (
      request: FastifyRequest<One & { Body: Static<typeof RubricArchiveRequestSchema> }>,
    ) =>
      as<never>(
        await svc.archive(
          contextFrom(request),
          request.params.courseId,
          request.params.rubricId,
          request.body.archived,
        ),
      ),
  };
}
export type RubricsController = ReturnType<typeof createRubricsController>;
