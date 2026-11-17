import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  UnsubscribeRequestSchema,
  UnsubscribeTokenQuerySchema,
  UpdateNotificationSettingsRequestSchema,
  UpdatePreferenceRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { IdParams, ListQuery, PlatformReadBody } from './notifications.schemas';
import type { NotificationsService } from './notifications.service';

// Reads the validated request, calls the service, maps the result. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
export function createNotificationsController(deps: {
  notificationsService: NotificationsService;
}) {
  const { notificationsService: svc } = deps;
  return {
    list: async (request: FastifyRequest<{ Querystring: Static<typeof ListQuery> }>) =>
      as<never>(await svc.list(contextFrom(request), request.query)),

    /** 304 when the client's ETag still matches: the poll costs the two statements and no body. */
    unread: async (request: FastifyRequest, reply: FastifyReply) => {
      const u = await svc.unread(contextFrom(request));
      void reply.header('etag', u.etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === u.etag) return reply.code(304).send();
      return { unread: u.unread };
    },

    markRead: async (request: FastifyRequest<{ Params: Static<typeof IdParams> }>) => ({
      updated: await svc.markRead(contextFrom(request), request.params.id),
    }),
    markAllRead: async (request: FastifyRequest) => ({
      updated: await svc.markRead(contextFrom(request), null),
    }),

    preferences: async (request: FastifyRequest) =>
      as<never>(await svc.preferences(contextFrom(request))),
    updatePreference: async (
      request: FastifyRequest<{ Body: Static<typeof UpdatePreferenceRequestSchema> }>,
    ) => as<never>(await svc.updatePreference(contextFrom(request), request.body)),

    settings: async (request: FastifyRequest) => svc.settings(contextFrom(request)),
    updateSettings: async (
      request: FastifyRequest<{ Body: Static<typeof UpdateNotificationSettingsRequestSchema> }>,
    ) => svc.updateSettings(contextFrom(request), request.body),

    unsubscribeInfo: async (
      request: FastifyRequest<{ Querystring: Static<typeof UnsubscribeTokenQuerySchema> }>,
      reply: FastifyReply,
    ) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      return as<never>(await svc.unsubscribeInfo(request.tenant?.id ?? null, request.query.t));
    },
    unsubscribe: async (
      request: FastifyRequest<{ Body: Static<typeof UnsubscribeRequestSchema> }>,
    ) => ({
      unsubscribed: true as const,
      ...(await svc.unsubscribe(request.tenant?.id ?? null, request.body.token)),
    }),
    oneClick: async (
      request: FastifyRequest<{ Querystring: Static<typeof UnsubscribeTokenQuerySchema> }>,
    ) => ({
      unsubscribed: true as const,
      ...(await svc.unsubscribe(request.tenant?.id ?? null, request.query.t)),
    }),

    platformList: async (request: FastifyRequest<{ Querystring: Static<typeof ListQuery> }>) =>
      as<never>(await svc.platformList(contextFrom(request), request.query)),
    platformRead: async (request: FastifyRequest<{ Body: Static<typeof PlatformReadBody> }>) => ({
      updated: await svc.platformRead(contextFrom(request), request.body.id ?? null),
    }),
  };
}
export type NotificationsController = ReturnType<typeof createNotificationsController>;
