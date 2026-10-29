import type { Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { AuditListQuerySchema } from '../../contracts';
import { contextFrom } from '../../core/context';
import type { AuditEntry, AuditService } from './audit.service';

// Reads the validated request, calls the service, maps the result to the response DTO.
// No DB access, no business rules.
type Query = { Querystring: Static<typeof AuditListQuerySchema> };

const toDto = (e: AuditEntry) => ({
  id: e.id,
  actorUserId: e.actorUserId,
  action: e.action,
  targetType: e.targetType,
  targetId: e.targetId,
  metadata: (e.metadata ?? {}) as Record<string, unknown>,
  createdAt: e.createdAt.toISOString(),
});

export function createAuditController(deps: { auditService: AuditService }) {
  const { auditService } = deps;
  return {
    listTenant: async (request: FastifyRequest<Query>) => {
      const page = await auditService.listTenantLog(contextFrom(request), request.query);
      return { items: page.items.map(toDto), nextCursor: page.nextCursor };
    },
    listPlatform: async (request: FastifyRequest<Query>) => {
      const page = await auditService.listPlatformLog(contextFrom(request), request.query);
      return { items: page.items.map(toDto), nextCursor: page.nextCursor };
    },
  };
}
export type AuditController = ReturnType<typeof createAuditController>;
