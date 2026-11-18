import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { NotificationsController } from './notifications.controller';
import * as s from './notifications.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic.
export function createNotificationsRoutes(deps: {
  notificationsController: NotificationsController;
}): FastifyPluginAsyncTypebox {
  const { notificationsController: c } = deps;
  return async (app) => {
    const own = { config: { authenticated: true } } as const;
    app.get('/notifications', { ...own, schema: s.listRouteSchema }, c.list);
    // the bell polls this every 60 s while the tab is visible
    app.get(
      '/notifications/unread-count',
      {
        config: { authenticated: true, rateLimit: { max: 240, timeWindow: '1 minute' } },
        schema: s.unreadRouteSchema,
      },
      c.unread,
    );
    app.post(
      '/notifications/read-all',
      { ...own, schema: s.markAllReadRouteSchema },
      c.markAllRead,
    );
    app.post('/notifications/:id/read', { ...own, schema: s.markReadRouteSchema }, c.markRead);
    app.get(
      '/me/notification-preferences',
      { ...own, schema: s.preferencesRouteSchema },
      c.preferences,
    );
    app.put(
      '/me/notification-preferences',
      { ...own, schema: s.updatePreferenceRouteSchema },
      c.updatePreference,
    );
    app.get(
      '/notifications/settings',
      { config: { permission: 'notification.settings.manage' }, schema: s.settingsRouteSchema },
      c.settings,
    );
    app.patch(
      '/notifications/settings',
      {
        config: { permission: 'notification.settings.manage' },
        schema: s.updateSettingsRouteSchema,
      },
      c.updateSettings,
    );

    // unsubscribe: public, the signed token is the authority (a GET never changes anything: link scanners prefetch)
    app.get(
      '/notifications/unsubscribe',
      {
        config: { public: true, strictRateLimit: { max: 120, windowMs: 60_000 } },
        schema: s.unsubscribeInfoRouteSchema,
      },
      c.unsubscribeInfo,
    );
    app.post(
      '/notifications/unsubscribe',
      {
        config: { public: true, strictRateLimit: { max: 120, windowMs: 60_000 } },
        schema: s.unsubscribeRouteSchema,
      },
      c.unsubscribe,
    );
    // RFC 8058: the mailbox provider POSTs `List-Unsubscribe=One-Click` (form encoded) to the List-Unsubscribe URL. It cannot
    // send Origin or X-Requested-With: CSRF-exempt, authenticated by the token. One of exactly two exemptions (route test).
    await app.register(async (oc) => {
      oc.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 1024 },
        (_req, body, done) => done(null, body),
      );
      oc.post(
        '/notifications/unsubscribe/one-click',
        {
          // mailbox providers unsubscribe many people from the same few addresses: a generous shared limit
          config: {
            public: true,
            csrfExempt: 'rfc8058-one-click',
            strictRateLimit: { max: 1200, windowMs: 60_000 },
          },
          bodyLimit: 1024,
          schema: s.oneClickRouteSchema,
        },
        c.oneClick,
      );
    });

    app.get(
      '/platform/notifications',
      { config: { permission: 'platform.usage.read' }, schema: s.platformListRouteSchema },
      c.platformList,
    );
    app.post(
      '/platform/notifications/read',
      { config: { permission: 'platform.usage.read' }, schema: s.platformReadRouteSchema },
      c.platformRead,
    );
  };
}
