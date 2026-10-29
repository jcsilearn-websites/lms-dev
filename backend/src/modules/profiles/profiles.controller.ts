import type { Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type {
  BulkMoveSectionRequestSchema,
  MemberParamsSchema,
  MoveSectionRequestSchema,
  UpdateProfileRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { ProfilesService, Row } from './profiles.service';

// Reads the validated request, calls the service, maps the row to the response DTO.
// No DB access, no business rules.
type Params = { Params: Static<typeof MemberParamsSchema> };

/** snake_case row -> API shape (camelCase; the batch label is "<admission>-<graduation>"). */
export function toProfileDto(r: Row) {
  const b = r.admission_year != null ? `${r.admission_year}-${r.graduation_year}` : null;
  return {
    userId: r.user_id as string,
    profileType: r.profile_type as 'student' | 'faculty' | 'staff',
    phone: (r.phone as string | null) ?? null,
    designation: (r.designation as string | null) ?? null,
    registerNumber: (r.register_number as string | null) ?? null,
    employeeId: (r.employee_id as string | null) ?? null,
    departmentId: (r.department_id as string | null) ?? null,
    departmentCode: (r.department_code as string | null) ?? null,
    programId: (r.program_id as string | null) ?? null,
    programCode: (r.program_code as string | null) ?? null,
    programName: (r.program_name as string | null) ?? null,
    batchId: (r.batch_id as string | null) ?? null,
    batchLabel: b,
    sectionId: (r.section_id as string | null) ?? null,
    sectionCode: (r.section_code as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export function createProfilesController(deps: { profilesService: ProfilesService }) {
  const { profilesService: svc } = deps;
  return {
    get: async (request: FastifyRequest<Params>) =>
      toProfileDto(await svc.get(contextFrom(request), request.params.userId)),

    getOwn: async (request: FastifyRequest) => toProfileDto(await svc.getOwn(contextFrom(request))),

    update: async (
      request: FastifyRequest<Params & { Body: Static<typeof UpdateProfileRequestSchema> }>,
    ) => toProfileDto(await svc.update(contextFrom(request), request.params.userId, request.body)),

    moveOne: async (
      request: FastifyRequest<Params & { Body: Static<typeof MoveSectionRequestSchema> }>,
    ) => svc.moveOne(contextFrom(request), request.params.userId, request.body.sectionId),

    moveMany: async (
      request: FastifyRequest<{ Body: Static<typeof BulkMoveSectionRequestSchema> }>,
    ) => svc.moveMany(contextFrom(request), request.body.userIds, request.body.sectionId),
  };
}
export type ProfilesController = ReturnType<typeof createProfilesController>;
