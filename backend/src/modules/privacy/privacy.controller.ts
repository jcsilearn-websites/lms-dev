import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestDataExportSchema } from '../../contracts';
import { contextFrom } from '../../core/context';
import type { IdParams } from './privacy.schemas';
import type { PrivacyService } from './privacy.service';

// Reads the validated request, calls the service, maps the result. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
export function createPrivacyController(deps: { privacyService: PrivacyService }) {
  const { privacyService: svc } = deps;
  return {
    requestExport: async (
      request: FastifyRequest<{ Body: Static<typeof RequestDataExportSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.requestExport(contextFrom(request), request.body);
      return reply.code(202).send(as<never>(r));
    },
    listExports: async (request: FastifyRequest) =>
      as<never>(await svc.listExports(contextFrom(request))),
    downloadExport: async (request: FastifyRequest<{ Params: Static<typeof IdParams> }>) =>
      as<never>(await svc.downloadLink(contextFrom(request), request.params.id)),
  };
}
export type PrivacyController = ReturnType<typeof createPrivacyController>;
