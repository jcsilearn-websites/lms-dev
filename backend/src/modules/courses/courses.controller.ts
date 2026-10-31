import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AddOfferingSectionRequestSchema,
  AddParticipantRequestSchema,
  CourseListQuerySchema,
  CourseParamsSchema,
  CreateCourseRequestSchema,
  CreateOfferingRequestSchema,
  MyCoursesQuerySchema,
  OfferingListQuerySchema,
  OfferingParamsSchema,
  OfferingSectionParamsSchema,
  ParticipantListQuerySchema,
  ParticipantParamsSchema,
  UpdateCourseRequestSchema,
  UpdateOfferingRequestSchema,
  UpdateParticipantRequestSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { CoursesService, Row } from './courses.service';

// Reads the validated request, calls the service, maps the row to the response DTO.
// No DB access, no business rules.
const iso = (v: unknown) => new Date(v as string).toISOString();
const isoOrNull = (v: unknown) => (v == null ? null : iso(v));
const str = (v: unknown) => (v as string | null | undefined) ?? null;

export function toCourseDto(r: Row) {
  return {
    id: r.id as string,
    code: r.code as string,
    title: r.title as string,
    description: r.description as string,
    credits: (r.credits as number | null) ?? null,
    departmentId: str(r.department_id),
    departmentCode: str(r.department_code),
    departmentName: str(r.department_name),
    archivedAt: isoOrNull(r.archived_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toOfferingDto(r: Row) {
  return {
    id: r.id as string,
    courseId: r.course_id as string,
    courseCode: r.course_code as string,
    courseTitle: r.course_title as string,
    title: r.title as string,
    label: r.label as string,
    termId: r.term_id as string,
    termName: r.term_name as string,
    status: r.status as 'draft' | 'published' | 'archived',
    copyStatus: r.copy_status as string,
    completionThreshold: Number(r.completion_threshold),
    behindAfterDays: Number(r.behind_after_days),
    myParticipation: str(r.my_participation) as 'instructor' | 'assistant' | 'learner' | null,
    sectionCount: r.section_count as number,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toParticipantDto(r: Row) {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    displayName: r.display_name as string,
    email: r.email as string,
    participation: r.participation as 'instructor' | 'assistant' | 'learner',
    source: r.source as 'manual' | 'section',
    sectionCode: str(r.section_code),
    status: r.status as 'active' | 'removed',
    createdAt: iso(r.created_at),
  };
}

const page = <T, U>(p: { items: T[]; nextCursor: string | null }, f: (t: T) => U) => ({
  items: p.items.map(f),
  nextCursor: p.nextCursor,
});

export function createCoursesController(deps: { coursesService: CoursesService }) {
  const { coursesService: svc } = deps;
  type Id = { Params: Static<typeof OfferingParamsSchema> };
  return {
    listCourses: async (
      request: FastifyRequest<{ Querystring: Static<typeof CourseListQuerySchema> }>,
    ) => page(await svc.listCourses(contextFrom(request), request.query), toCourseDto),
    getCourse: async (request: FastifyRequest<{ Params: Static<typeof CourseParamsSchema> }>) =>
      toCourseDto(await svc.getCourse(contextFrom(request), request.params.id)),
    createCourse: async (
      request: FastifyRequest<{ Body: Static<typeof CreateCourseRequestSchema> }>,
      reply: FastifyReply,
    ) =>
      reply.code(201).send(toCourseDto(await svc.createCourse(contextFrom(request), request.body))),
    updateCourse: async (
      request: FastifyRequest<{
        Params: Static<typeof CourseParamsSchema>;
        Body: Static<typeof UpdateCourseRequestSchema>;
      }>,
    ) => toCourseDto(await svc.updateCourse(contextFrom(request), request.params.id, request.body)),

    listOfferings: async (
      request: FastifyRequest<{ Querystring: Static<typeof OfferingListQuerySchema> }>,
    ) => page(await svc.listOfferings(contextFrom(request), request.query), toOfferingDto),
    myCourses: async (
      request: FastifyRequest<{ Querystring: Static<typeof MyCoursesQuerySchema> }>,
    ) => page(await svc.listMine(contextFrom(request), request.query), toOfferingDto),
    getOffering: async (request: FastifyRequest<Id>) =>
      toOfferingDto(await svc.getOffering(contextFrom(request), request.params.id)),
    createOffering: async (
      request: FastifyRequest<{ Body: Static<typeof CreateOfferingRequestSchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(toOfferingDto(await svc.createOffering(contextFrom(request), request.body))),
    updateOffering: async (
      request: FastifyRequest<Id & { Body: Static<typeof UpdateOfferingRequestSchema> }>,
    ) =>
      toOfferingDto(
        await svc.updateOffering(contextFrom(request), request.params.id, request.body),
      ),
    publish: async (request: FastifyRequest<Id>) =>
      toOfferingDto(await svc.publish(contextFrom(request), request.params.id)),
    unpublish: async (request: FastifyRequest<Id>) =>
      toOfferingDto(await svc.unpublish(contextFrom(request), request.params.id)),
    archive: async (request: FastifyRequest<Id>) =>
      toOfferingDto(await svc.archive(contextFrom(request), request.params.id)),

    listSections: async (request: FastifyRequest<Id>) => ({
      items: (await svc.listSections(contextFrom(request), request.params.id)).map((r) => ({
        sectionId: r.section_id as string,
        sectionCode: r.section_code as string,
        batchId: r.batch_id as string,
        batchLabel: r.batch_label as string,
        programCode: r.program_code as string,
      })),
    }),
    addSection: async (
      request: FastifyRequest<Id & { Body: Static<typeof AddOfferingSectionRequestSchema> }>,
    ) => {
      await svc.addSection(contextFrom(request), request.params.id, request.body.sectionId);
      return { status: 'added' };
    },
    removeSection: async (
      request: FastifyRequest<{ Params: Static<typeof OfferingSectionParamsSchema> }>,
    ) => {
      await svc.removeSection(contextFrom(request), request.params.id, request.params.sectionId);
      return { status: 'removed' };
    },

    listParticipants: async (
      request: FastifyRequest<Id & { Querystring: Static<typeof ParticipantListQuerySchema> }>,
    ) =>
      page(
        await svc.listParticipants(contextFrom(request), request.params.id, request.query),
        toParticipantDto,
      ),
    addParticipant: async (
      request: FastifyRequest<Id & { Body: Static<typeof AddParticipantRequestSchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(
          toParticipantDto(
            await svc.addParticipant(contextFrom(request), request.params.id, request.body),
          ),
        ),
    updateParticipant: async (
      request: FastifyRequest<{
        Params: Static<typeof ParticipantParamsSchema>;
        Body: Static<typeof UpdateParticipantRequestSchema>;
      }>,
    ) =>
      toParticipantDto(
        await svc.changeParticipant(
          contextFrom(request),
          request.params.id,
          request.params.participantId,
          request.body.participation,
        ),
      ),
    removeParticipant: async (
      request: FastifyRequest<{ Params: Static<typeof ParticipantParamsSchema> }>,
    ) => {
      await svc.removeParticipant(
        contextFrom(request),
        request.params.id,
        request.params.participantId,
      );
      return { status: 'removed' };
    },
  };
}
export type CoursesController = ReturnType<typeof createCoursesController>;
