import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);
const NullableNumber = Nullable(Type.Number());

// The gradebook (step 11). Three audiences:
//  * the INSTRUCTOR / assistant: structure, the grid (learners x items), marks, overrides, the explanation of a number;
//  * the INSTITUTION ADMIN: the approval queue, a review of a submitted gradebook, unlock;
//  * the LEARNER: own released items, category totals and a provisional final, or the approved record.
// Numbers that must stay exact (marks, points) travel as JSON numbers with at most two decimals, or as decimal STRINGS in
// requests (`"12.5"`), so the client never rounds.

export const DECIMAL_PATTERN = '^[0-9]{1,6}([.][0-9]{1,2})?$';
export const MAX_MARK_CELLS = 5000;
export const MAX_GRID_PAGE = 500;
export const MAX_GRADEBOOK_ITEMS = 120;
export const MAX_GRADEBOOK_CATEGORIES = 30;

export const GradebookParamsSchema = Type.Object({ id: Id });
export const GradebookLearnerParamsSchema = Type.Object({ id: Id, participantId: Id });
export const GradebookImportParamsSchema = Type.Object({ id: Id, importId: Id });
export const GradebookVersionParamsSchema = Type.Object({
  id: Id,
  versionNo: Type.Integer({ minimum: 1 }),
});

// ------------------------------------------------------------------ vocabulary
export const MissingPolicySchema = Type.Union([
  Type.Literal('exclude'),
  Type.Literal('zero_after_due'),
]);
export const RoundModeSchema = Type.Union([
  Type.Literal('half_up'),
  Type.Literal('half_even'),
  Type.Literal('floor'),
  Type.Literal('ceil'),
]);
export const GradebookStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('submitted'),
  Type.Literal('returned'),
  Type.Literal('locked'),
]);
export type GradebookStatus = Static<typeof GradebookStatusSchema>;
export const ItemSourceSchema = Type.Union([
  Type.Literal('assessment'),
  Type.Literal('assignment'),
  Type.Literal('manual'),
]);
/** The state of one cell of the grid: s scored, o overridden, z counted as zero, x missing (left out), p handed in not graded, h hidden */
export const CellStateSchema = Type.Union([
  Type.Literal('s'),
  Type.Literal('o'),
  Type.Literal('z'),
  Type.Literal('x'),
  Type.Literal('p'),
  Type.Literal('h'),
]);
export type CellState = Static<typeof CellStateSchema>;
/**
 * [state, value (the earned points in the item's points), dropped 0|1]. A JSON array of mixed items: fast-json-stringify cannot
 * serialize a TypeBox tuple whose items are unions, so the schema is a plain array and the exact shape is the type `Cell`.
 */
export const CellSchema = Type.Array(Type.Union([Type.String(), Type.Integer(), Type.Null()]));
export type Cell = readonly [CellState, string | null, number];

// ------------------------------------------------------------------ structure
export const BandSchema = Type.Object({
  minPercent: Type.Number(),
  label: Type.String(),
  gradePoints: NullableNumber,
  isPass: Type.Boolean(),
});
export const GradeScaleInputSchema = Type.Object({
  id: Type.Optional(Id),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  bands: Type.Array(
    Type.Object({
      minPercent: Type.Number({ minimum: 0, maximum: 100, multipleOf: 0.001 }),
      label: Type.String({ minLength: 1, maxLength: 12 }),
      gradePoints: Type.Optional(
        Nullable(Type.Number({ minimum: 0, maximum: 99, multipleOf: 0.01 })),
      ),
      isPass: Type.Boolean(),
    }),
    { minItems: 1, maxItems: 30 },
  ),
});
export type GradeScaleInput = Static<typeof GradeScaleInputSchema>;
export const GradeScaleSchema = Type.Object({
  id: Id,
  name: Type.String(),
  archived: Type.Boolean(),
  bands: Type.Array(BandSchema),
  offerings: Type.Integer(),
});
export type GradeScale = Static<typeof GradeScaleSchema>;
export const GradeScaleListSchema = Type.Object({ items: Type.Array(GradeScaleSchema) });
export const GradeScaleListQuerySchema = Type.Object({
  includeArchived: Type.Optional(Type.Boolean()),
});
export const GradeScaleParamsSchema = Type.Object({ scaleId: Id });
export const GradeScaleArchiveRequestSchema = Type.Object({ archived: Type.Boolean() });
export const GradeScaleIdSchema = Type.Object({ id: Id });

export const CategoryInputSchema = Type.Object({
  id: Type.Optional(Id),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  weight: Type.Number({ minimum: 0, maximum: 1000, multipleOf: 0.001 }),
  dropLowest: Type.Integer({ minimum: 0, maximum: 20 }),
  missingPolicy: MissingPolicySchema,
});
export type CategoryInput = Static<typeof CategoryInputSchema>;
export const CategoriesSaveRequestSchema = Type.Object({
  categories: Type.Array(CategoryInputSchema, { minItems: 1, maxItems: MAX_GRADEBOOK_CATEGORIES }),
});

export const ItemInputSchema = Type.Object({
  id: Type.Optional(Id),
  source: ItemSourceSchema,
  contentItemId: Type.Optional(Nullable(Id)),
  title: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 120 }))),
  categoryId: Id,
  points: Type.Number({ exclusiveMinimum: 0, maximum: 100000, multipleOf: 0.01 }),
  extraCredit: Type.Boolean(),
  dueAt: Type.Optional(Nullable(DateTime)),
  released: Type.Optional(Type.Boolean()),
  assistantsMayEnter: Type.Optional(Type.Boolean()),
});
export type ItemInput = Static<typeof ItemInputSchema>;
export const ItemsSaveRequestSchema = Type.Object({
  items: Type.Array(ItemInputSchema, { maxItems: MAX_GRADEBOOK_ITEMS }),
});

export const EXPORT_KEY_PATTERN =
  '^(register|name|email|section|final|percent|grade|(item|cat):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
export const ExportColumnSchema = Type.Object({
  key: Type.String({ pattern: EXPORT_KEY_PATTERN }),
  header: Type.String({ minLength: 1, maxLength: 80 }),
});
export type ExportColumn = Static<typeof ExportColumnSchema>;
export const SettingsPatchSchema = Type.Object({
  weighted: Type.Optional(Type.Boolean()),
  outOf: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100000, multipleOf: 0.01 })),
  roundMode: Type.Optional(RoundModeSchema),
  roundDecimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  scaleId: Type.Optional(Nullable(Id)),
  exportLayout: Type.Optional(
    Nullable(Type.Array(ExportColumnSchema, { minItems: 1, maxItems: 200 })),
  ),
});
export type SettingsPatch = Static<typeof SettingsPatchSchema>;

export const GradebookItemSchema = Type.Object({
  id: Id,
  categoryId: Id,
  source: ItemSourceSchema,
  contentItemId: Nullable(Id),
  title: Type.String(),
  points: Type.Number(),
  extraCredit: Type.Boolean(),
  dueAt: Nullable(DateTime),
  released: Type.Boolean(),
  assistantsMayEnter: Type.Boolean(),
});
export type GradebookItem = Static<typeof GradebookItemSchema>;
export const GradebookCategorySchema = Type.Object({
  id: Id,
  name: Type.String(),
  weight: Type.Number(),
  dropLowest: Type.Integer(),
  missingPolicy: MissingPolicySchema,
});
export type GradebookCategory = Static<typeof GradebookCategorySchema>;
export const GradebookEventSchema = Type.Object({
  action: Type.String(),
  at: DateTime,
  by: Nullable(Type.String()),
  comment: Nullable(Type.String()),
  versionNo: Type.Integer(),
  selfApproved: Type.Boolean(),
});
export const CandidateSchema = Type.Object({
  contentItemId: Id,
  title: Type.String(),
  kind: Type.Union([Type.Literal('assessment'), Type.Literal('assignment')]),
  defaultPoints: Type.Number(),
});
export const ExcludedLearnerSchema = Type.Object({
  participantId: Id,
  name: Type.String(),
  registerNumber: Nullable(Type.String()),
  reason: Type.Union([
    Type.Literal('removed_from_college'),
    Type.Literal('removed_from_offering'),
    Type.Literal('left_the_class'),
  ]),
  hasMarks: Type.Boolean(),
});
export type ExcludedLearner = Static<typeof ExcludedLearnerSchema>;
export const GradebookConfigSchema = Type.Object({
  id: Id,
  offeringId: Id,
  status: GradebookStatusSchema,
  versionNo: Type.Integer(),
  weighted: Type.Boolean(),
  outOf: Type.Number(),
  roundMode: RoundModeSchema,
  roundDecimals: Type.Integer(),
  scale: Nullable(Type.Object({ id: Id, name: Type.String(), bands: Type.Array(BandSchema) })),
  categories: Type.Array(GradebookCategorySchema),
  items: Type.Array(GradebookItemSchema),
  exportLayout: Nullable(Type.Array(ExportColumnSchema)),
  submittedAt: Nullable(DateTime),
  submittedBy: Nullable(Type.String()),
  reviewComment: Nullable(Type.String()),
  selfApprovalAllowed: Type.Boolean(),
  lockedVersions: Type.Array(
    Type.Object({
      versionNo: Type.Integer(),
      lockedAt: DateTime,
      learnerCount: Type.Integer(),
      /** learners left out of that snapshot, each with the reason */
      excluded: Type.Array(ExcludedLearnerSchema),
      selfApproved: Type.Boolean(),
      approvedBy: Nullable(Type.String()),
    }),
  ),
  events: Type.Array(GradebookEventSchema),
  candidates: Type.Array(CandidateSchema),
  markCounts: Type.Record(Type.String(), Type.Integer()),
});
export type GradebookConfig = Static<typeof GradebookConfigSchema>;

// ------------------------------------------------------------------ the grid
export const GridQuerySchema = Type.Object({
  section: Type.Optional(Id),
  after: Type.Optional(Type.String({ maxLength: 120 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GRID_PAGE })),
});
export const CategoryTotalSchema = Type.Object({
  e: NullableNumber,
  m: NullableNumber,
  p: NullableNumber,
});
export type CategoryTotal = Static<typeof CategoryTotalSchema>;
export const GridRowSchema = Type.Object({
  participantId: Id,
  name: Type.String(),
  email: Type.String(),
  registerNumber: Nullable(Type.String()),
  section: Nullable(Type.String()),
  cells: Type.Record(Type.String(), CellSchema),
  cats: Type.Record(Type.String(), CategoryTotalSchema),
  finalMarks: NullableNumber,
  finalPercent: NullableNumber,
  grade: Nullable(Type.String()),
  isPass: Nullable(Type.Boolean()),
  overridden: Type.Boolean(),
});
export type GridRow = Omit<Static<typeof GridRowSchema>, 'cells'> & { cells: Record<string, Cell> };
export const GridSchema = Type.Object({
  rows: Type.Array(GridRowSchema),
  nextCursor: Nullable(Type.String()),
  total: Nullable(Type.Integer()),
});
export type Grid = Omit<Static<typeof GridSchema>, 'rows'> & { rows: GridRow[] };

// ------------------------------------------------------------------ the explanation of a number
export const ExplainItemSchema = Type.Object({
  id: Id,
  title: Type.String(),
  state: CellStateSchema,
  points: Type.Number(),
  extra: Type.Boolean(),
  dropped: Type.Boolean(),
  earned: NullableNumber,
  percent: NullableNumber,
});
export type ExplainItem = Static<typeof ExplainItemSchema>;
export const ExplainCategorySchema = Type.Object({
  id: Id,
  name: Type.String(),
  weight: Type.Number(),
  dropLowest: Type.Integer(),
  missingPolicy: MissingPolicySchema,
  counts: Type.Boolean(),
  earned: NullableNumber,
  max: NullableNumber,
  percent: NullableNumber,
  items: Type.Array(ExplainItemSchema),
});
export type ExplainCategory = Static<typeof ExplainCategorySchema>;
export const ExplanationSchema = Type.Object({
  weighted: Type.Boolean(),
  outOf: Type.Number(),
  rounding: Type.Object({ mode: RoundModeSchema, decimals: Type.Integer() }),
  categories: Type.Array(ExplainCategorySchema),
  weightTotal: NullableNumber,
  /** the final before rounding (6 decimals, for the eye) */
  unrounded: NullableNumber,
  rounded: NullableNumber,
  final: NullableNumber,
  percent: NullableNumber,
  grade: Type.Optional(Nullable(Type.String())),
  isPass: Type.Optional(Nullable(Type.Boolean())),
  overridden: Type.Boolean(),
});
export type Explanation = Static<typeof ExplanationSchema>;
export const OverrideSchema = Type.Object({
  itemId: Nullable(Id),
  points: Type.Number(),
  reason: Type.String(),
  setAt: DateTime,
  setBy: Nullable(Type.String()),
});
export const LearnerExplanationSchema = Type.Object({
  participantId: Id,
  name: Type.String(),
  email: Type.String(),
  registerNumber: Nullable(Type.String()),
  section: Nullable(Type.String()),
  explanation: ExplanationSchema,
  overrides: Type.Array(OverrideSchema),
});
export type LearnerExplanation = Static<typeof LearnerExplanationSchema>;

// ------------------------------------------------------------------ marks
export const MarkCellInputSchema = Type.Object({
  itemId: Id,
  participantId: Id,
  /** null clears the cell */
  points: Nullable(Type.String({ pattern: DECIMAL_PATTERN })),
  /** the value the client saw; a different stored value is reported as a conflict instead of being overwritten */
  expected: Type.Optional(Nullable(Type.String({ pattern: DECIMAL_PATTERN }))),
});
export const MarksSaveRequestSchema = Type.Object({
  cells: Type.Array(MarkCellInputSchema, { minItems: 1, maxItems: MAX_MARK_CELLS }),
});
export const RecomputedRowSchema = Type.Object({
  cells: Type.Record(Type.String(), CellSchema),
  cats: Type.Record(Type.String(), CategoryTotalSchema),
  finalMarks: NullableNumber,
  finalPercent: NullableNumber,
  grade: Nullable(Type.String()),
  isPass: Nullable(Type.Boolean()),
  overridden: Type.Boolean(),
});
export const MarksSaveResponseSchema = Type.Object({
  saved: Type.Integer(),
  unchanged: Type.Integer(),
  conflicts: Type.Array(Type.Object({ itemId: Id, participantId: Id, current: NullableNumber })),
  invalid: Type.Array(Type.Object({ itemId: Id, participantId: Id, reason: Type.String() })),
  rows: Type.Record(Type.String(), RecomputedRowSchema),
});
export type RecomputedRow = Omit<Static<typeof RecomputedRowSchema>, 'cells'> & {
  cells: Record<string, Cell>;
};
export type MarksSaveResponse = Omit<Static<typeof MarksSaveResponseSchema>, 'rows'> & {
  rows: Record<string, RecomputedRow>;
};

export const MarkImportRequestSchema = Type.Object({
  csv: Type.String({ minLength: 1, maxLength: 2_000_000 }),
});
export const MarkImportSummarySchema = Type.Object({
  importId: Id,
  status: Type.String(),
  rows: Type.Integer(),
  cells: Type.Integer(),
  errorCells: Type.Integer(),
  errorRows: Type.Integer(),
  errors: Type.Array(
    Type.Object({
      row: Type.Integer(),
      register: Type.String(),
      column: Type.String(),
      value: Type.String(),
      error: Type.String(),
    }),
  ),
  unknownColumns: Type.Array(Type.String()),
});
export type MarkImportSummary = Static<typeof MarkImportSummarySchema>;
export const MarkImportApplyRequestSchema = Type.Object({
  skipInvalid: Type.Optional(Type.Boolean()),
});
export const MarkImportApplyResponseSchema = Type.Object({
  saved: Type.Integer(),
  unchanged: Type.Integer(),
  skippedRows: Type.Integer(),
});

// ------------------------------------------------------------------ overrides
export const OverrideRequestSchema = Type.Object({
  /** null = the final marks */
  itemId: Nullable(Id),
  points: Type.String({ pattern: DECIMAL_PATTERN }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export const OverrideRevokeQuerySchema = Type.Object({ itemId: Type.Optional(Id) });

// ------------------------------------------------------------------ workflow
export const ProblemSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  items: Type.Optional(Type.Array(Type.String())),
});
export const ReviewRequestSchema = Type.Object({
  comment: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const ReturnRequestSchema = Type.Object({
  comment: Type.String({ minLength: 3, maxLength: 1000 }),
});
export const UnlockRequestSchema = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export const WorkflowResultSchema = Type.Object({
  status: GradebookStatusSchema,
  versionNo: Type.Integer(),
});
export const ReviewSchema = Type.Composite([
  GradebookConfigSchema,
  Type.Object({
    problems: Type.Array(ProblemSchema),
    excluded: Type.Array(ExcludedLearnerSchema),
    stats: Type.Object({
      learners: Type.Integer(),
      withFinal: Type.Integer(),
      overridden: Type.Integer(),
      average: NullableNumber,
      min: NullableNumber,
      max: NullableNumber,
      failing: Type.Integer(),
      grades: Type.Record(Type.String(), Type.Integer()),
    }),
  }),
]);
export type Review = Static<typeof ReviewSchema>;

export const QueueQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('submitted'), Type.Literal('returned'), Type.Literal('locked')]),
  ),
  after: Type.Optional(Type.String({ maxLength: 120 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const QueueEntrySchema = Type.Object({
  gradebookId: Id,
  offeringId: Id,
  courseCode: Type.String(),
  courseTitle: Type.String(),
  termName: Type.String(),
  label: Type.String(),
  status: GradebookStatusSchema,
  versionNo: Type.Integer(),
  submittedAt: Nullable(DateTime),
  submittedBy: Nullable(Type.String()),
  updatedAt: DateTime,
});
export const QueueSchema = Type.Object({
  items: Type.Array(QueueEntrySchema),
  nextCursor: Nullable(Type.String()),
});
export type Queue = Static<typeof QueueSchema>;

// ------------------------------------------------------------------ college setting
export const GradebookSettingsSchema = Type.Object({ allowSelfApproval: Type.Boolean() });
export type GradebookSettings = Static<typeof GradebookSettingsSchema>;

// ------------------------------------------------------------------ snapshots and exports
export const ExportQuerySchema = Type.Object({
  version: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const SnapshotMetaSchema = Type.Object({
  versionNo: Type.Integer(),
  lockedAt: DateTime,
  approvedBy: Nullable(Type.String()),
  selfApproved: Type.Boolean(),
  learnerCount: Type.Integer(),
  excluded: Type.Array(ExcludedLearnerSchema),
});

// ------------------------------------------------------------------ the learner
export const LearnerGradesSchema = Type.Object({
  status: GradebookStatusSchema,
  /** false only for an approved (locked) record */
  provisional: Type.Boolean(),
  /** the gradebook was unlocked after an approval: the figures are being revised */
  underRevision: Type.Boolean(),
  versionNo: Type.Integer(),
  final: Type.Object({
    marks: NullableNumber,
    percent: NullableNumber,
    grade: Nullable(Type.String()),
    isPass: Nullable(Type.Boolean()),
  }),
  explanation: ExplanationSchema,
});
export type LearnerGrades = Static<typeof LearnerGradesSchema>;

export const ResultSchemaOk = Type.Object({ ok: Type.Boolean() });
