import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { EmailController } from './email.controller';
import * as s from './email.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic.
export function createEmailRoutes(deps: {
  emailController: EmailController;
}): FastifyPluginAsyncTypebox {
  const { emailController: c } = deps;
  return async (app) => {
    app.get(
      '/me/email-status',
      { config: { authenticated: true }, schema: s.myEmailStatusRouteSchema },
      c.myStatus,
    );
    app.get(
      '/email/suppressions',
      { config: { permission: 'email.suppression.manage' }, schema: s.listSuppressionsRouteSchema },
      c.list,
    );
    app.delete(
      '/email/suppressions/:id',
      { config: { permission: 'email.suppression.manage' }, schema: s.clearSuppressionRouteSchema },
      c.clear,
    );
    app.get(
      '/platform/email/suppressions',
      {
        config: { permission: 'platform.email.manage' },
        schema: s.platformListSuppressionsRouteSchema,
      },
      c.platformList,
    );
    app.delete(
      '/platform/email/suppressions/:id',
      {
        config: { permission: 'platform.email.manage' },
        schema: s.platformClearSuppressionRouteSchema,
      },
      c.platformClear,
    );
    app.put(
      '/platform/tenants/:id/email-sender',
      { config: { permission: 'platform.email.manage' }, schema: s.setEmailSenderRouteSchema },
      c.setSender,
    );

    // The provider's webhook: its own context, where a JSON body stays the RAW bytes (the signature covers them exactly).
    // Public (the provider has no session) and CSRF-exempt (it cannot send Origin / X-Requested-With): authenticated by
    // the signature instead. One of exactly two exemptions, pinned by route-declarations.test.ts.
    await app.register(async (wh) => {
      wh.removeContentTypeParser('application/json');
      wh.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 },
        (_req, body, done) => done(null, body),
      );
      wh.post(
        '/email/webhooks/:provider',
        {
          config: {
            public: true,
            csrfExempt: 'signed-webhook',
            rateLimit: { max: 1200, timeWindow: '1 minute' },
            strictRateLimit: { max: 1200, windowMs: 60_000 },
          },
          bodyLimit: 2 * 1024 * 1024,
          schema: s.webhookRouteSchema,
        },
        c.webhook,
      );
    });
  };
}
