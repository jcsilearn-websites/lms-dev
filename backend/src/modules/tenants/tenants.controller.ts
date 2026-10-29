import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AdminInviteRequestSchema,
  CreateTenantRequestSchema,
  MemberListQuerySchema,
  TenantListQuerySchema,
  TenantParamsSchema,
  UpdateBrandingRequestSchema,
  UpdateTenantRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import { NotFoundError } from '../../core/errors';
import type { Member } from '../memberships';
import type {
  AdminInviteResult,
  PlatformTenant,
  PlatformTenantDetail,
  TenantsPlatformService,
} from './tenants.platform.service';
import type { TenantsService } from './tenants.service';

// Reads the validated request, calls the service, maps the result to the response DTO.
// No DB access, no business rules.
type Params = { Params: Static<typeof TenantParamsSchema> };

const tenantDto = (t: PlatformTenant) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  status: t.status,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});
const detailDto = (t: PlatformTenantDetail) => ({
  ...tenantDto(t),
  members: t.members,
  activeAdmins: t.activeAdmins,
});
const inviteDto = (i: AdminInviteResult) => ({
  outcome: i.outcome,
  userId: i.userId,
  membershipId: i.membershipId,
});
const memberDto = (m: Member) => ({
  id: m.id,
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  role: m.role,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
});

/** The admin host's port (development) so the emailed link keeps working locally. */
const scopeOf = (request: FastifyRequest) => ({
  portSuffix: request.hostInfo.kind === 'none' ? '' : request.hostInfo.portSuffix,
});

export function createTenantsController(deps: {
  tenantsService: TenantsService;
  platformService: TenantsPlatformService;
}) {
  const { tenantsService, platformService: platform } = deps;
  return {
    /** Public. Only a tenant host has branding; the admin host and unknown hosts get 404. */
    info: async (request: FastifyRequest) => {
      const tenant = request.tenant;
      if (!tenant) throw new NotFoundError('tenant_not_found', 'Tenant not found');
      return tenantsService.getInfo(tenant.id);
    },

    updateBranding: async (
      request: FastifyRequest<{ Body: Static<typeof UpdateBrandingRequestSchema> }>,
    ) => tenantsService.updateBranding(contextFrom(request), request.body),

    list: async (
      request: FastifyRequest<{ Querystring: Static<typeof TenantListQuerySchema> }>,
    ) => {
      const page = await platform.list(contextFrom(request), request.query);
      return { items: page.items.map(tenantDto), nextCursor: page.nextCursor };
    },

    get: async (request: FastifyRequest<Params>) =>
      detailDto(await platform.get(contextFrom(request), request.params.id)),

    create: async (
      request: FastifyRequest<{ Body: Static<typeof CreateTenantRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await platform.create(contextFrom(request), request.body, scopeOf(request));
      reply.status(201);
      return { tenant: tenantDto(r.tenant), adminInvite: inviteDto(r.invite) };
    },

    update: async (
      request: FastifyRequest<Params & { Body: Static<typeof UpdateTenantRequestSchema> }>,
    ) => tenantDto(await platform.update(contextFrom(request), request.params.id, request.body)),

    suspend: async (request: FastifyRequest<Params>) =>
      tenantDto(await platform.setStatus(contextFrom(request), request.params.id, 'suspended')),

    reactivate: async (request: FastifyRequest<Params>) =>
      tenantDto(await platform.setStatus(contextFrom(request), request.params.id, 'active')),

    inviteAdmin: async (
      request: FastifyRequest<Params & { Body: Static<typeof AdminInviteRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await platform.inviteAdmin(
        contextFrom(request),
        request.params.id,
        request.body,
        scopeOf(request),
      );
      reply.status(201);
      return inviteDto(r);
    },

    members: async (
      request: FastifyRequest<Params & { Querystring: Static<typeof MemberListQuerySchema> }>,
    ) => {
      const page = await platform.members(contextFrom(request), request.params.id, request.query);
      return { items: page.items.map(memberDto), nextCursor: page.nextCursor };
    },
  };
}
export type TenantsController = ReturnType<typeof createTenantsController>;
