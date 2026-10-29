import type { FastifyReply, FastifyRequest } from 'fastify';
import { contextFrom } from '../../core/context';
import type { SessionsService } from './sessions.service';

// Reads the validated request, calls the service, maps the result to the response DTO.
export function createSessionsController(deps: { sessionsService: SessionsService }) {
  const { sessionsService } = deps;
  return {
    list: async (request: FastifyRequest<{ Querystring: { limit?: number; after?: string } }>) => {
      const page = await sessionsService.listMine(contextFrom(request), request.query);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          ip: s.ip,
          userAgent: s.userAgent,
          current: s.current,
        })),
      };
    },

    revoke: async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await sessionsService.revokeMine(contextFrom(request), request.params.id);
      return { status: 'ok' };
    },
  };
}
export type SessionsController = ReturnType<typeof createSessionsController>;
