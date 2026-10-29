import { type Static, Type } from '@sinclair/typebox';

// Academic structure: academic years -> terms; departments -> programs -> batches -> sections.
const Id = Type.String({ format: 'uuid' });
const DateOnly = Type.String({ format: 'date' });
const DateTime = Type.String({ format: 'date-time' });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);

export const IdParamsSchema = Type.Object({ id: Id });

/** `false` (default): active only; `true`: archived only; `all`: both. */
export const ArchivedFilterSchema = Type.Union([
  Type.Literal('false'),
  Type.Literal('true'),
  Type.Literal('all'),
]);
const pageFields = {
  archived: Type.Optional(ArchivedFilterSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
};
const page = <T extends ReturnType<typeof Type.Object>>(item: T) =>
  Type.Object({ items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) });

const stamps = { archivedAt: NullableDateTime, createdAt: DateTime, updatedAt: DateTime };

// ---------------------------------------------------------------- academic years
export const AcademicYearSchema = Type.Object({
  id: Id,
  label: Type.String(),
  startDate: DateOnly,
  endDate: DateOnly,
  isCurrent: Type.Boolean(),
  ...stamps,
});
export const CreateAcademicYearSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 32 }),
  startDate: DateOnly,
  endDate: DateOnly,
});
export const UpdateAcademicYearSchema = Type.Partial(CreateAcademicYearSchema);
export const AcademicYearListQuerySchema = Type.Object({
  current: Type.Optional(Type.Boolean()),
  ...pageFields,
});
export const AcademicYearListSchema = page(AcademicYearSchema);

// ---------------------------------------------------------------- terms
export const TermSchema = Type.Object({
  id: Id,
  academicYearId: Id,
  name: Type.String(),
  startDate: DateOnly,
  endDate: DateOnly,
  ...stamps,
});
export const CreateTermSchema = Type.Object({
  academicYearId: Id,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  startDate: DateOnly,
  endDate: DateOnly,
});
export const UpdateTermSchema = Type.Partial(Type.Omit(CreateTermSchema, ['academicYearId']));
export const TermListQuerySchema = Type.Object({
  academicYearId: Type.Optional(Id),
  ...pageFields,
});
export const TermListSchema = page(TermSchema);

// ---------------------------------------------------------------- departments
export const DepartmentSchema = Type.Object({
  id: Id,
  code: Type.String(),
  name: Type.String(),
  ...stamps,
});
export const CreateDepartmentSchema = Type.Object({
  /** Uppercase letters, digits, - and _ (normalized to uppercase), up to 20 characters. */
  code: Type.String({ minLength: 1, maxLength: 20 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
});
export const UpdateDepartmentSchema = Type.Partial(CreateDepartmentSchema);
export const DepartmentListQuerySchema = Type.Object({ ...pageFields });
export const DepartmentListSchema = page(DepartmentSchema);

// ---------------------------------------------------------------- programs
export const ProgramSchema = Type.Object({
  id: Id,
  departmentId: Id,
  code: Type.String(),
  name: Type.String(),
  durationYears: Type.Integer(),
  ...stamps,
});
export const CreateProgramSchema = Type.Object({
  departmentId: Id,
  code: Type.String({ minLength: 1, maxLength: 20 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  durationYears: Type.Integer({ minimum: 1, maximum: 8 }),
});
export const UpdateProgramSchema = Type.Partial(Type.Omit(CreateProgramSchema, ['departmentId']));
export const ProgramListQuerySchema = Type.Object({
  departmentId: Type.Optional(Id),
  ...pageFields,
});
export const ProgramListSchema = page(ProgramSchema);

// ---------------------------------------------------------------- batches
export const BatchSchema = Type.Object({
  id: Id,
  programId: Id,
  admissionYear: Type.Integer(),
  graduationYear: Type.Integer(),
  /** e.g. "2023-2027" */
  label: Type.String(),
  ...stamps,
});
export const CreateBatchSchema = Type.Object({
  programId: Id,
  admissionYear: Type.Integer({ minimum: 1950, maximum: 2200 }),
  graduationYear: Type.Integer({ minimum: 1951, maximum: 2210 }),
});
export const UpdateBatchSchema = Type.Partial(Type.Pick(CreateBatchSchema, ['graduationYear']));
export const BatchListQuerySchema = Type.Object({
  programId: Type.Optional(Id),
  admissionYear: Type.Optional(Type.Integer({ minimum: 1950, maximum: 2200 })),
  ...pageFields,
});
export const BatchListSchema = page(BatchSchema);

// ---------------------------------------------------------------- sections
export const SectionSchema = Type.Object({
  id: Id,
  batchId: Id,
  code: Type.String(),
  ...stamps,
});
export const CreateSectionSchema = Type.Object({
  batchId: Id,
  code: Type.String({ minLength: 1, maxLength: 10 }),
});
export const UpdateSectionSchema = Type.Partial(Type.Omit(CreateSectionSchema, ['batchId']));
export const SectionListQuerySchema = Type.Object({
  batchId: Type.Optional(Id),
  ...pageFields,
});
export const SectionListSchema = page(SectionSchema);

export type AcademicYearDto = Static<typeof AcademicYearSchema>;
export type TermDto = Static<typeof TermSchema>;
export type DepartmentDto = Static<typeof DepartmentSchema>;
export type ProgramDto = Static<typeof ProgramSchema>;
export type BatchDto = Static<typeof BatchSchema>;
export type SectionDto = Static<typeof SectionSchema>;
