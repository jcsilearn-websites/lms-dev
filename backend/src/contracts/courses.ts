import { type Static, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
// Null FIRST: Ajv (coerceTypes) would otherwise coerce a JSON null into "" through the string branch
const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([Type.Null(), t]);
const NullableNumber = Type.Union([Type.Null(), Type.Number()]);

export const ParticipationTypeSchema = Type.Union([
  Type.Literal('instructor'),
  Type.Literal('assistant'),
  Type.Literal('learner'),
]);

export const OFFERING_STATUSES = ['draft', 'published', 'archived'] as const;
export const OfferingStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('archived'),
]);
export type OfferingStatus = Static<typeof OfferingStatusSchema>;

// ------------------------------------------------------------------ courses
export const CourseSchema = Type.Object({
  id: Id,
  code: Type.String(),
  title: Type.String(),
  description: Type.String(),
  credits: NullableNumber,
  /** Optional: cross-department electives and skill courses have none. */
  departmentId: Nullable(Id),
  departmentCode: Nullable(Type.String()),
  departmentName: Nullable(Type.String()),
  archivedAt: Nullable(DateTime),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type CourseDto = Static<typeof CourseSchema>;

export const CourseParamsSchema = Type.Object({ id: Id });

export const CreateCourseRequestSchema = Type.Object({
  /** letters, digits and . _ - (stored upper case) */
  code: Type.String({ minLength: 1, maxLength: 20, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
  credits: Type.Optional(Type.Number({ minimum: 0, maximum: 99 })),
  departmentId: Type.Optional(Id),
});

export const UpdateCourseRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
  credits: Type.Optional(Type.Union([Type.Null(), Type.Number({ minimum: 0, maximum: 99 })])),
  departmentId: Type.Optional(Nullable(Id)),
  archived: Type.Optional(Type.Boolean()),
});

export const CourseListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
  /** code or title prefix */
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  /** a department id, or "none" for courses without a department */
  department: Type.Optional(Type.Union([Id, Type.Literal('none')])),
  archived: Type.Optional(Type.Boolean()),
});

export const CoursePageSchema = Type.Object({
  items: Type.Array(CourseSchema),
  nextCursor: Nullable(Type.String()),
});
export type CoursePage = Static<typeof CoursePageSchema>;

// ------------------------------------------------------------------ offerings
export const OfferingSchema = Type.Object({
  id: Id,
  courseId: Id,
  courseCode: Type.String(),
  courseTitle: Type.String(),
  /** The offering's own title when it has one, else the course title. */
  title: Type.String(),
  label: Type.String(),
  termId: Id,
  termName: Type.String(),
  status: OfferingStatusSchema,
  /** none | running | done | failed: a copy of content from another offering. */
  copyStatus: Type.String(),
  /** The caller's part in it (null for an administrator who does not participate). */
  myParticipation: Type.Union([Type.Null(), ParticipationTypeSchema]),
  sectionCount: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type OfferingDto = Static<typeof OfferingSchema>;

export const OfferingParamsSchema = Type.Object({ id: Id });

export const CreateOfferingRequestSchema = Type.Object({
  courseId: Id,
  termId: Id,
  label: Type.Optional(Type.String({ maxLength: 40 })),
  titleOverride: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

export const UpdateOfferingRequestSchema = Type.Object({
  label: Type.Optional(Type.String({ maxLength: 40 })),
  titleOverride: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 200 }))),
});

export const OfferingListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
  courseId: Type.Optional(Id),
  termId: Type.Optional(Id),
  status: Type.Optional(OfferingStatusSchema),
});

export const OfferingPageSchema = Type.Object({
  items: Type.Array(OfferingSchema),
  nextCursor: Nullable(Type.String()),
});
export type OfferingPage = Static<typeof OfferingPageSchema>;

// sections of an offering
export const OfferingSectionSchema = Type.Object({
  sectionId: Id,
  sectionCode: Type.String(),
  batchId: Id,
  batchLabel: Type.String(),
  programCode: Type.String(),
});
export const OfferingSectionsSchema = Type.Object({ items: Type.Array(OfferingSectionSchema) });
export type OfferingSectionDto = Static<typeof OfferingSectionSchema>;
export const AddOfferingSectionRequestSchema = Type.Object({ sectionId: Id });
export const OfferingSectionParamsSchema = Type.Object({ id: Id, sectionId: Id });

// ------------------------------------------------------------------ participants
export const ParticipantSchema = Type.Object({
  id: Id,
  userId: Id,
  displayName: Type.String(),
  email: Type.String(),
  participation: ParticipationTypeSchema,
  source: Type.Union([Type.Literal('manual'), Type.Literal('section')]),
  sectionCode: Nullable(Type.String()),
  status: Type.Union([Type.Literal('active'), Type.Literal('removed')]),
  createdAt: DateTime,
});
export type ParticipantDto = Static<typeof ParticipantSchema>;

export const ParticipantListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
  participation: Type.Optional(ParticipationTypeSchema),
  /** include people who were removed */
  includeRemoved: Type.Optional(Type.Boolean()),
});
export const ParticipantPageSchema = Type.Object({
  items: Type.Array(ParticipantSchema),
  nextCursor: Nullable(Type.String()),
});
export type ParticipantPage = Static<typeof ParticipantPageSchema>;

export const AddParticipantRequestSchema = Type.Object({
  userId: Id,
  participation: ParticipationTypeSchema,
});
export const UpdateParticipantRequestSchema = Type.Object({
  participation: ParticipationTypeSchema,
});
export const ParticipantParamsSchema = Type.Object({ id: Id, participantId: Id });

// ------------------------------------------------------------------ my courses
export const MyCoursesQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
});

export const OkResponseSchema = Type.Object({ status: Type.String() });
export type OkResponse = Static<typeof OkResponseSchema>;
