import { type Static, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
// Null FIRST: Ajv (coerceTypes) would otherwise coerce a JSON null into "" through the string branch
const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([Type.Null(), t]);

export const PROFILE_TYPES = ['student', 'faculty', 'staff'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];
export const ProfileTypeSchema = Type.Union([
  Type.Literal('student'),
  Type.Literal('faculty'),
  Type.Literal('staff'),
]);

/**
 * A member's profile. `profileType` is a LABEL (display, filtering, reports): it grants no permission.
 * Students carry registerNumber / batch / section (the department follows from the batch);
 * faculty and staff carry employeeId / department.
 */
export const ProfileSchema = Type.Object({
  userId: Id,
  profileType: ProfileTypeSchema,
  phone: Nullable(Type.String()),
  designation: Nullable(Type.String()),
  registerNumber: Nullable(Type.String()),
  employeeId: Nullable(Type.String()),
  departmentId: Nullable(Id),
  departmentCode: Nullable(Type.String()),
  programCode: Nullable(Type.String()),
  batchId: Nullable(Id),
  /** e.g. "2023-2027" */
  batchLabel: Nullable(Type.String()),
  sectionId: Nullable(Id),
  sectionCode: Nullable(Type.String()),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type ProfileDto = Static<typeof ProfileSchema>;

/**
 * PATCH /members/:userId/profile. Creates the profile when there is none (profileType is then
 * required); otherwise changes the sent fields. `null` clears a field.
 */
export const UpdateProfileRequestSchema = Type.Object({
  profileType: Type.Optional(ProfileTypeSchema),
  /** digits, spaces and hyphens, optional leading + (e.g. "+91 98765 43210") */
  phone: Type.Optional(Nullable(Type.String({ maxLength: 20 }))),
  designation: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  registerNumber: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
  employeeId: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
  departmentId: Type.Optional(Nullable(Id)),
  batchId: Type.Optional(Nullable(Id)),
  sectionId: Type.Optional(Nullable(Id)),
});

export const MoveSectionRequestSchema = Type.Object({ sectionId: Id });
export const BulkMoveSectionRequestSchema = Type.Object({
  userIds: Type.Array(Id, { minItems: 1, maxItems: 500, uniqueItems: true }),
  sectionId: Id,
});
export const MoveSectionResponseSchema = Type.Object({
  moved: Type.Integer(),
  /** already in that section */
  unchanged: Type.Integer(),
  /** not a student, no profile, not in the section's batch, or not a member of this college */
  skipped: Type.Array(Id),
});
