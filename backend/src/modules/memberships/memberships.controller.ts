import type { Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type {
  ChangeMemberRoleRequestSchema,
  MemberListQuerySchema,
  MemberParamsSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { Member, MembershipsService } from './memberships.service';

// Reads the validated request, calls the service, maps the result to the response DTO.
// No DB access, no business rules.
type Params = { Params: Static<typeof MemberParamsSchema> };

export const toMemberDto = (m: Member) => ({
  id: m.id,
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  role: m.role,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
  profileType: m.profileType,
  registerNumber: m.registerNumber,
  employeeId: m.employeeId,
  departmentId: m.departmentId,
  batchId: m.batchId,
  sectionId: m.sectionId,
});

export function createMembershipsController(deps: { membershipsService: MembershipsService }) {
  const { membershipsService } = deps;
  return {
    list: async (
      request: FastifyRequest<{ Querystring: Static<typeof MemberListQuerySchema> }>,
    ) => {
      const page = await membershipsService.list(contextFrom(request), request.query);
      return { items: page.items.map(toMemberDto), nextCursor: page.nextCursor };
    },

    get: async (request: FastifyRequest<Params>) =>
      toMemberDto(await membershipsService.get(contextFrom(request), request.params.userId)),

    changeRole: async (
      request: FastifyRequest<Params & { Body: Static<typeof ChangeMemberRoleRequestSchema> }>,
    ) =>
      toMemberDto(
        await membershipsService.changeRole(
          contextFrom(request),
          request.params.userId,
          request.body.role,
        ),
      ),

    suspend: async (request: FastifyRequest<Params>) =>
      toMemberDto(await membershipsService.suspend(contextFrom(request), request.params.userId)),

    reactivate: async (request: FastifyRequest<Params>) =>
      toMemberDto(await membershipsService.reactivate(contextFrom(request), request.params.userId)),

    remove: async (request: FastifyRequest<Params>) => {
      await membershipsService.remove(contextFrom(request), request.params.userId);
      return { status: 'removed' };
    },
  };
}
export type MembershipsController = ReturnType<typeof createMembershipsController>;
