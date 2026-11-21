import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Data protection (step 14b-1): "download my data". The archive is the caller's own data in ONE college, built by the worker,
// downloadable for 7 days.

export const DATA_EXPORT_STATUSES = ['queued', 'building', 'ready', 'failed', 'expired'] as const;
export const DataExportStatusSchema = Type.Union(DATA_EXPORT_STATUSES.map((s) => Type.Literal(s)));

export const DataExportSchema = Type.Object({
  id: Id,
  status: DataExportStatusSchema,
  requestedAt: DateTime,
  readyAt: Nullable(DateTime),
  /** the archive is deleted at this time */
  expiresAt: Nullable(DateTime),
  sizeBytes: Nullable(Type.Number()),
  /** rows per section of the archive (numbers only) */
  counts: Nullable(Type.Record(Type.String(), Type.Number())),
});
export type DataExport = Static<typeof DataExportSchema>;

/** The password is asked again: a stolen session alone cannot take the person's data. */
export const RequestDataExportSchema = Type.Object(
  { password: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
export type RequestDataExport = Static<typeof RequestDataExportSchema>;

export const RequestDataExportResultSchema = Type.Object({
  export: DataExportSchema,
  /** true when an earlier request is still being built: no second one is made */
  alreadyInProgress: Type.Boolean(),
});

export const DataExportListSchema = Type.Object({ items: Type.Array(DataExportSchema) });

export const DataExportDownloadSchema = Type.Object({
  url: Type.String(),
  expiresAt: DateTime,
  fileName: Type.String(),
});
export type DataExportDownload = Static<typeof DataExportDownloadSchema>;
