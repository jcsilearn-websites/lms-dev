import type { FastifyRequest } from 'fastify';

/** Once the tenant is known (auth step), call this so every later log line carries tenant_id. */
export function bindTenantToLog(request: FastifyRequest, tenantId: string): void {
  request.log = request.log.child({ tenant_id: tenantId });
}
