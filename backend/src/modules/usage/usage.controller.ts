import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UsageExportQuerySchema, UsageQuerySchema } from '../../contracts';
import { contextFrom } from '../../core/context';
import type { UsageService } from './usage.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function createUsageController(deps: { usageService: UsageService }) {
  const { usageService: svc } = deps;
  return {
    list: async (request: FastifyRequest<{ Querystring: Static<typeof UsageQuerySchema> }>) =>
      as<never>(await svc.list(contextFrom(request), request.query.month)),
    export: async (
      request: FastifyRequest<{ Querystring: Static<typeof UsageExportQuerySchema> }>,
      reply: FastifyReply,
    ) => {
      const ctx = contextFrom(request);
      const month = request.query.month;
      const name = `usage-${(month ?? 'current').slice(0, 7)}`;
      void reply
        .header('content-disposition', `attachment; filename="${name}.${request.query.format}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store');
      if (request.query.format === 'xlsx') {
        const stream = await svc.xlsx(ctx, month);
        return reply.header('content-type', XLSX).send(stream);
      }
      const csv = await svc.csv(ctx, month);
      return reply.header('content-type', 'text/csv; charset=utf-8').send(csv);
    },
  };
}
export type UsageController = ReturnType<typeof createUsageController>;
