import type { FastifyRequest } from 'fastify';
import { NotFoundError } from './errors';

// Route preHandlers that are not authorization. Authorization is declared per route with
// config.permission / config.authenticated / config.public (see core/authz/route-policy.ts).
export async function requireKnownHost(request: FastifyRequest): Promise<void> {
  if (request.hostInfo.kind === 'none') {
    throw new NotFoundError('tenant_not_found', 'Tenant not found');
  }
}
