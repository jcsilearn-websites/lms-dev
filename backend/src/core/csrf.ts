import type { FastifyInstance } from 'fastify';
import { ForbiddenError } from './errors';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The ONLY routes that may skip the CSRF check, each for a client that cannot send our headers and is authenticated by
 * something else than a cookie (step 13, ADR 0021):
 *   - RFC 8058 one-click unsubscribe: the MAILBOX PROVIDER posts `List-Unsubscribe=One-Click`; the signed token decides.
 *   - the email provider's event webhook: the provider posts; its signature over the raw body decides.
 * A route needs BOTH the `csrfExempt` declaration AND its path in this list; route-declarations.test.ts pins the list.
 */
export const CSRF_EXEMPT_ROUTES: Readonly<Record<string, CsrfExemption>> = {
  'POST /api/notifications/unsubscribe/one-click': 'rfc8058-one-click',
  'POST /api/email/webhooks/:provider': 'signed-webhook',
};
export type CsrfExemption = 'rfc8058-one-click' | 'signed-webhook';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** see CSRF_EXEMPT_ROUTES: honoured only for the routes listed there */
    csrfExempt?: CsrfExemption;
  }
}

function originHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * CSRF defence for cookie sessions, applied to every state-changing request except the two routes above:
 * (a) Origin - or Referer when Origin is absent - must match the request host, and
 * (b) the custom header `X-Requested-With: lms` must be present (forces a CORS preflight cross-site).
 */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (!STATE_CHANGING.has(request.method)) return;
    const exempt = request.routeOptions.config?.csrfExempt;
    if (exempt && CSRF_EXEMPT_ROUTES[`${request.method} ${request.routeOptions.url}`] === exempt) {
      return;
    }
    const origin = request.headers.origin ?? request.headers.referer;
    const fromHost = originHost(typeof origin === 'string' ? origin : undefined);
    const ownHost = request.host.toLowerCase();
    if (!fromHost || fromHost !== ownHost || request.headers['x-requested-with'] !== 'lms') {
      throw new ForbiddenError('csrf_rejected', 'Request rejected');
    }
  });
}
