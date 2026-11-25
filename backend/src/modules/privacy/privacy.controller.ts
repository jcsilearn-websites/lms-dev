import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  PlatformAccountErasureBodySchema,
  RequestDataExportSchema,
  RequestErasureSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { ErasureService } from './privacy.erasure.service';
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

// the member's own erasure routes and the administrators' (erasure inside a college)
export function createErasureController(deps: { erasureService: ErasureService }) {
  const { erasureService: svc } = deps;
  return {
    preview: async (request: FastifyRequest) => as<never>(await svc.preview(contextFrom(request))),
    mine: async (request: FastifyRequest) => as<never>(await svc.mine(contextFrom(request))),
    request: async (
      request: FastifyRequest<{ Body: Static<typeof RequestErasureSchema> }>,
      reply: FastifyReply,
    ) =>
      reply.code(202).send(as<never>(await svc.requestErasure(contextFrom(request), request.body))),
    cancelMine: async (request: FastifyRequest) =>
      as<never>(await svc.cancelMine(contextFrom(request))),
    adminList: async (request: FastifyRequest) =>
      as<never>(await svc.adminList(contextFrom(request))),
    accountMine: async (request: FastifyRequest) =>
      as<never>(await svc.accountMine(contextFrom(request))),
    requestAccount: async (
      request: FastifyRequest<{ Body: Static<typeof RequestErasureSchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(202)
        .send(as<never>(await svc.requestAccountErasure(contextFrom(request), request.body))),
    platformRequest: async (
      request: FastifyRequest<{ Body: Static<typeof PlatformAccountErasureBodySchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(202)
        .send(as<never>(await svc.platformRequest(contextFrom(request), request.body))),
    platformList: async (request: FastifyRequest) =>
      as<never>(await svc.platformList(contextFrom(request))),
    platformDecide:
      (action: 'approve' | 'reject' | 'cancel') =>
      async (request: FastifyRequest<{ Params: Static<typeof IdParams> }>) =>
        as<never>(await svc.platformDecide(contextFrom(request), request.params.id, action)),
    decide:
      (action: 'approve' | 'reject' | 'cancel') =>
      async (request: FastifyRequest<{ Params: Static<typeof IdParams> }>) =>
        as<never>(await svc.decide(contextFrom(request), request.params.id, action)),
  };
}
export type ErasureController = ReturnType<typeof createErasureController>;
