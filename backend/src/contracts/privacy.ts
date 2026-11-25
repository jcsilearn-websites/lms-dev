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

// ------------------------------------------------------------------ erasure inside a college (step 14b-1, part 3)
// A member asks to be erased from ONE college; an institution admin approves; 7 days of grace; either can cancel until then.
export const ERASURE_STATUSES = [
  'pending_approval',
  'approved',
  'executing',
  'done',
  'cancelled',
  'rejected',
  'expired',
] as const;
export const ErasureStatusSchema = Type.Union(ERASURE_STATUSES.map((s) => Type.Literal(s)));
export type ErasureStatus = Static<typeof ErasureStatusSchema>;

/** The numbers the screens, the e-mails and docs/data-retention.md agree on (days). */
export const ERASURE_RULES = {
  /** an undecided request ends after this many days (and the member is told) */
  requestExpiresAfterDays: 30,
  /** from the approval to the execution: either side can cancel until then */
  graceDays: 7,
  /** how long a backup of the database can still hold the person (the logical dumps; the ledger erases them again after a restore) */
  backupRetentionDays: 30,
  /** the data export archive of the person is deleted within this many days of being prepared */
  exportRetentionDays: 7,
} as const;

export const ErasureRequestSchema = Type.Object({
  id: Id,
  status: ErasureStatusSchema,
  requestedAt: DateTime,
  /** an undecided request ends here */
  expiresAt: Nullable(DateTime),
  /** the execution starts at this time; a cancel is possible until then */
  graceUntil: Nullable(DateTime),
});
export type ErasureRequest = Static<typeof ErasureRequestSchema>;

const Counts = Type.Record(Type.String(), Type.Number());
/** COUNTS ONLY: how much will be removed and how much is kept (the words are on the screen, the numbers are the member's own). */
export const ErasurePreviewSchema = Type.Object({
  /** the member is the last active institution admin: the college cannot lose its last administrator */
  lastAdmin: Type.Boolean(),
  erased: Counts,
  kept: Counts,
  /** the request in progress, if any */
  open: Nullable(ErasureRequestSchema),
  rules: Type.Object({
    requestExpiresAfterDays: Type.Number(),
    graceDays: Type.Number(),
    backupRetentionDays: Type.Number(),
    exportRetentionDays: Type.Number(),
  }),
});
export type ErasurePreview = Static<typeof ErasurePreviewSchema>;

export const RequestErasureSchema = Type.Object(
  { password: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
export type RequestErasure = Static<typeof RequestErasureSchema>;

export const RequestErasureResultSchema = Type.Object({
  request: ErasureRequestSchema,
  alreadyInProgress: Type.Boolean(),
});

export const MyErasureSchema = Type.Object({ request: Nullable(ErasureRequestSchema) });

export const ErasureAdminItemSchema = Type.Intersect([
  ErasureRequestSchema,
  Type.Object({
    /** the request is the first half of "erase my whole account": the account goes too when this one is executed */
    withAccount: Type.Boolean(),
    /** the member's name as the college sees it (a pseudonym once they are erased) */
    memberName: Type.String(),
    memberEmail: Type.String(),
  }),
]);
export const ErasureAdminListSchema = Type.Object({ items: Type.Array(ErasureAdminItemSchema) });

// ------------------------------------------------------------------ erasure of the GLOBAL account (step 14b-1, part 4)
// Allowed only when the person has no membership that is not removed. A member of exactly ONE college asks for both at once
// ("combined": the college request, then the account); everyone else goes through a platform administrator.
export const ACCOUNT_ERASURE_STATUSES = [
  'waiting_college',
  'pending_approval',
  'approved',
  'executing',
  'done',
  'cancelled',
  'rejected',
  'expired',
] as const;
export const AccountErasureRequestSchema = Type.Object({
  id: Id,
  status: Type.Union(ACCOUNT_ERASURE_STATUSES.map((s) => Type.Literal(s))),
  source: Type.Union([
    Type.Literal('member_combined'),
    Type.Literal('platform'),
    Type.Literal('ledger'),
  ]),
  requestedAt: DateTime,
  expiresAt: Nullable(DateTime),
  graceUntil: Nullable(DateTime),
});
export type AccountErasureRequest = Static<typeof AccountErasureRequestSchema>;

export const MyAccountErasureSchema = Type.Object({
  request: Nullable(AccountErasureRequestSchema),
  /** this college is the person's ONLY one, so "erase my account" is available here */
  eligible: Type.Boolean(),
  /** how many colleges the person is a member of (not removed) */
  colleges: Type.Number(),
});
export const RequestAccountErasureResultSchema = Type.Object({
  request: AccountErasureRequestSchema,
  collegeRequest: Nullable(ErasureRequestSchema),
  alreadyInProgress: Type.Boolean(),
});

export const PlatformAccountErasureBodySchema = Type.Object(
  { email: Type.String({ minLength: 3, maxLength: 320 }) },
  { additionalProperties: false },
);
export const PlatformAccountErasureItemSchema = Type.Intersect([
  AccountErasureRequestSchema,
  Type.Object({
    executedAt: Nullable(DateTime),
    requestedByName: Nullable(Type.String()),
    approvedByName: Nullable(Type.String()),
    /** the person as stored: the pseudonym once erased */
    personName: Type.String(),
    /** null once erased */
    personEmail: Nullable(Type.String()),
    erased: Type.Boolean(),
    /** the caller is not the one who filed it */
    canApprove: Type.Boolean(),
    canCancel: Type.Boolean(),
  }),
]);
export const PlatformAccountErasureListSchema = Type.Object({
  items: Type.Array(PlatformAccountErasureItemSchema),
  hasMore: Type.Boolean(),
});
