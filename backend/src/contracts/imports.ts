import { type Static, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);

export const IMPORT_KINDS = ['students', 'faculty'] as const;
export const ImportKindSchema = Type.Union([Type.Literal('students'), Type.Literal('faculty')]);

/**
 * parsing -> validated | failed;  validated -> queued (confirm) | cancelled;
 * queued -> processing -> completed | completed_with_errors | failed
 */
export const ImportStatusSchema = Type.Union([
  Type.Literal('parsing'),
  Type.Literal('validated'),
  Type.Literal('failed'),
  Type.Literal('queued'),
  Type.Literal('processing'),
  Type.Literal('completed'),
  Type.Literal('completed_with_errors'),
  Type.Literal('cancelled'),
]);

export const ImportSchema = Type.Object({
  id: Id,
  kind: ImportKindSchema,
  fileName: Type.String(),
  status: ImportStatusSchema,
  updateExisting: Type.Boolean(),
  skipInvalid: Type.Boolean(),
  counts: Type.Object({
    total: Type.Integer(),
    valid: Type.Integer(),
    invalid: Type.Integer(),
    /** applied (a member was created or updated) */
    processed: Type.Integer(),
    /** valid rows left alone: already a member (and "update existing" was off) or suspended */
    skipped: Type.Integer(),
    failed: Type.Integer(),
    created: Type.Integer(),
    updated: Type.Integer(),
  }),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: DateTime,
  confirmedAt: NullableDateTime,
  startedAt: NullableDateTime,
  finishedAt: NullableDateTime,
  /** the staged rows were deleted after the retention period: no row list or error report any more */
  rowsPurged: Type.Boolean(),
});
export type ImportDto = Static<typeof ImportSchema>;

export const ImportListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});
export const ImportListSchema = Type.Object({
  items: Type.Array(ImportSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export const UploadQuerySchema = Type.Object({ kind: ImportKindSchema });

export const ImportRowSchema = Type.Object({
  rowNumber: Type.Integer(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('valid'),
    Type.Literal('invalid'),
    Type.Literal('processed'),
    Type.Literal('skipped'),
    Type.Literal('failed'),
  ]),
  cells: Type.Record(Type.String(), Type.String()),
  errors: Type.Array(Type.Object({ column: Type.String(), message: Type.String() })),
  result: Type.Union([Type.String(), Type.Null()]),
});
export const ImportRowsQuerySchema = Type.Object({
  status: Type.Optional(ImportRowSchema.properties.status),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  /** the last row number of the previous page */
  after: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const ImportRowsSchema = Type.Object({
  items: Type.Array(ImportRowSchema),
  nextCursor: Type.Union([Type.Integer(), Type.Null()]),
});

export const ConfirmImportRequestSchema = Type.Object({
  /** update members who already exist in this college (default: skip and report them) */
  updateExisting: Type.Optional(Type.Boolean()),
  /** required when the file has invalid rows: they are left out and reported */
  skipInvalid: Type.Optional(Type.Boolean()),
});
