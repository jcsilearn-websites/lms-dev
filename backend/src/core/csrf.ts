import type { FastifyInstance } from 'fastify';
import { ForbiddenError } from './errors';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * CSRF defence for cookie sessions, applied to every state-changing request (nothing is exempt):
 * (a) Origin - or Referer when Origin is absent - must match the request host, and
 * (b) the custom header `X-Requested-With: lms` must be present (forces a CORS preflight cross-site).
 */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (!STATE_CHANGING.has(request.method)) return;
    const origin = request.headers.origin ?? request.headers.referer;
    const fromHost = originHost(typeof origin === 'string' ? origin : undefined);
    const ownHost = request.host.toLowerCase();
    if (!fromHost || fromHost !== ownHost || request.headers['x-requested-with'] !== 'lms') {
      throw new ForbiddenError('csrf_rejected', 'Request rejected');
    }
  });
}
