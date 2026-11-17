import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SetEmailSenderRequestSchema } from '../../contracts';
import { contextFrom } from '../../core/context';
import type { IdParams, ProviderParams, SuppressionQuery } from './email.schemas';
import type { EmailService } from './email.service';

// Reads the validated request, calls the service, maps the result. No DB access, no rules.
export function createEmailController(deps: { emailService: EmailService }) {
  const { emailService: svc } = deps;
  return {
    myStatus: async (request: FastifyRequest) => svc.myStatus(contextFrom(request)),

    list: async (request: FastifyRequest<{ Querystring: Static<typeof SuppressionQuery> }>) =>
      svc.tenantList(contextFrom(request), request.query),

    clear: async (
      request: FastifyRequest<{ Params: Static<typeof IdParams> }>,
      reply: FastifyReply,
    ) => {
      await svc.tenantClear(contextFrom(request), request.params.id);
      return reply.code(204).send();
    },

    /** The body arrives as the RAW buffer (the signature is over the exact bytes). */
    webhook: async (request: FastifyRequest<{ Params: Static<typeof ProviderParams> }>) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const received = await svc.ingestWebhook(request.params.provider, {
        headers: request.headers,
        rawBody: raw,
      });
      return { received };
    },

    platformList: async (
      request: FastifyRequest<{ Querystring: Static<typeof SuppressionQuery> }>,
    ) => svc.platformList(contextFrom(request), request.query),

    platformClear: async (
      request: FastifyRequest<{ Params: Static<typeof IdParams> }>,
      reply: FastifyReply,
    ) => {
      await svc.platformClear(contextFrom(request), request.params.id);
      return reply.code(204).send();
    },

    setSender: async (
      request: FastifyRequest<{
        Params: Static<typeof IdParams>;
        Body: Static<typeof SetEmailSenderRequestSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      await svc.setSender(contextFrom(request), request.params.id, request.body.fromAddress);
      return reply.code(204).send();
    },
  };
}
export type EmailController = ReturnType<typeof createEmailController>;
