import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { RichTextSchema } from './content';
import { UploadTargetSchema } from './files';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Assignments and rubrics (step 10). Two audiences:
//  * the LEARNER DTOs (assignment page, submissions, grade) hold only that learner's own data;
//  * the GRADING DTOs are addressed by a random `learnerKey` (never the participant id) and, while grading is blind, carry
//    no name, e-mail or register number: those fields are `null`, not merely hidden by the screen.

// ------------------------------------------------------------------ params
export const AssignmentItemParamsSchema = Type.Object({ id: Id, itemId: Id });
export const AssignmentFileParamsSchema = Type.Object({ id: Id, itemId: Id, fileId: Id });
export const AssignmentExtensionParamsSchema = Type.Object({
  id: Id,
  itemId: Id,
  participantId: Id,
});
export const AssignmentLearnerParamsSchema = Type.Object({ id: Id, itemId: Id, learnerKey: Id });
export const RubricCourseParamsSchema = Type.Object({ courseId: Id });
export const RubricParamsSchema = Type.Object({ courseId: Id, rubricId: Id });

// ------------------------------------------------------------------ rubrics
export const MAX_RUBRIC_CRITERIA = 20;
export const MAX_RUBRIC_LEVELS = 8;

export const RubricLevelInputSchema = Type.Object({
  /** kept when a level survives an edit; the server makes one for a new level */
  id: Type.Optional(Type.String({ pattern: '^[0-9a-f]{12}$' })),
  title: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  points: Type.Number({ minimum: 0, maximum: 1000 }),
});
export const RubricCriterionInputSchema = Type.Object({
  id: Type.Optional(Type.String({ pattern: '^[0-9a-f]{12}$' })),
  title: Type.String({ minLength: 1, maxLength: 150 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  levels: Type.Array(RubricLevelInputSchema, { minItems: 2, maxItems: MAX_RUBRIC_LEVELS }),
});
export const RubricInputSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  criteria: Type.Array(RubricCriterionInputSchema, { minItems: 1, maxItems: MAX_RUBRIC_CRITERIA }),
});
export type RubricInput = Static<typeof RubricInputSchema>;

export const RubricLevelSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  points: Type.Number(),
});
export const RubricCriterionSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  levels: Type.Array(RubricLevelSchema),
});
export type RubricCriterion = Static<typeof RubricCriterionSchema>;

export const RubricSummarySchema = Type.Object({
  id: Id,
  title: Type.String(),
  versionNo: Type.Integer(),
  maxPoints: Type.Number(),
  criteriaCount: Type.Integer(),
  archived: Type.Boolean(),
  /** assignments that use it */
  usedBy: Type.Integer(),
  updatedAt: DateTime,
});
export type RubricSummary = Static<typeof RubricSummarySchema>;
export const RubricDetailSchema = Type.Object({
  id: Id,
  courseId: Id,
  title: Type.String(),
  versionId: Id,
  versionNo: Type.Integer(),
  maxPoints: Type.Number(),
  criteria: Type.Array(RubricCriterionSchema),
  archived: Type.Boolean(),
  usedBy: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type RubricDetail = Static<typeof RubricDetailSchema>;
export const RubricListQuerySchema = Type.Object({
  includeArchived: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
});
export const RubricListSchema = Type.Object({
  items: Type.Array(RubricSummarySchema),
  nextCursor: Nullable(Id),
});
export type RubricList = Static<typeof RubricListSchema>;
export const RubricArchiveRequestSchema = Type.Object({ archived: Type.Boolean() });

// ------------------------------------------------------------------ settings (the builder)
export const LatePolicySchema = Type.Union([Type.Literal('none'), Type.Literal('allowed')]);
export const PenaltyKindSchema = Type.Union([Type.Literal('per_day'), Type.Literal('flat')]);
export const ReleaseModeSchema = Type.Union([Type.Literal('manual'), Type.Literal('immediate')]);

export const AssignmentSettingsSchema = Type.Object({
  instructions: Nullable(RichTextSchema),
  opensAt: Nullable(DateTime),
  dueAt: Nullable(DateTime),
  latePolicy: LatePolicySchema,
  lateCutoffAt: Nullable(DateTime),
  penaltyKind: PenaltyKindSchema,
  /** percent of the MAXIMUM points: per started day, or once */
  penaltyValue: Type.Number({ minimum: 0, maximum: 100 }),
  /** the penalty never exceeds this percent */
  penaltyCap: Type.Number({ minimum: 0, maximum: 100 }),
  maxPoints: Type.Number({ exclusiveMinimum: 0, maximum: 100000 }),
  /** percent of the maximum */
  passingScore: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
  allowFile: Type.Boolean(),
  allowText: Type.Boolean(),
  allowLink: Type.Boolean(),
  maxFiles: Type.Integer({ minimum: 1, maximum: 10 }),
  maxFileMb: Type.Integer({ minimum: 1, maximum: 100 }),
  resubmissionAllowed: Type.Boolean(),
  anonymousGrading: Type.Boolean(),
  releaseMode: ReleaseModeSchema,
});
export type AssignmentSettings = Static<typeof AssignmentSettingsSchema>;
export const UpdateAssignmentRequestSchema = Type.Partial(AssignmentSettingsSchema);
export type UpdateAssignmentRequest = Static<typeof UpdateAssignmentRequestSchema>;

export const AssignmentFileSchema = Type.Object({
  fileId: Id,
  name: Type.String(),
  size: Nullable(Type.Integer()),
  contentType: Type.String(),
});
export type AssignmentFile = Static<typeof AssignmentFileSchema>;

export const AssignmentConfigSchema = Type.Object({
  itemId: Id,
  courseId: Id,
  title: Type.String(),
  published: Type.Boolean(),
  settings: AssignmentSettingsSchema,
  attachments: Type.Array(AssignmentFileSchema),
  rubric: Nullable(
    Type.Object({
      rubricId: Id,
      versionId: Id,
      title: Type.String(),
      versionNo: Type.Integer(),
      maxPoints: Type.Number(),
      /** a newer version exists than the one this assignment is graded with */
      newerVersionAvailable: Type.Boolean(),
    }),
  ),
  submissionCount: Type.Integer(),
  gradedCount: Type.Integer(),
});
export type AssignmentConfig = Static<typeof AssignmentConfigSchema>;

export const ReplaceAttachmentsRequestSchema = Type.Object({
  fileIds: Type.Array(Id, { maxItems: 10 }),
});
export const AttachRubricRequestSchema = Type.Object({ rubricId: Nullable(Id) });

// ------------------------------------------------------------------ extensions (sensitive)
export const ExtensionInputSchema = Type.Object({
  extendedDueAt: DateTime,
  reason: Type.Optional(Type.String({ maxLength: 300 })),
});
export const ExtensionSchema = Type.Object({
  participantId: Id,
  learnerName: Type.String(),
  learnerEmail: Type.String(),
  extendedDueAt: DateTime,
  reason: Nullable(Type.String()),
  updatedAt: DateTime,
});
export const ExtensionsSchema = Type.Object({ items: Type.Array(ExtensionSchema) });
export type Extension = Static<typeof ExtensionSchema>;

// ------------------------------------------------------------------ the learner
export const GradeVisibleSchema = Type.Object({
  submissionVersionNo: Nullable(Type.Integer()),
  rawScore: Type.Number(),
  penaltyPercent: Type.Number(),
  penaltyPoints: Type.Number(),
  penaltyWaived: Type.Boolean(),
  finalScore: Type.Number(),
  maxPoints: Type.Number(),
  passingScore: Nullable(Type.Number()),
  feedback: Nullable(RichTextSchema),
  gradedAt: DateTime,
  releasedAt: Nullable(DateTime),
  overridden: Type.Boolean(),
  rubric: Nullable(
    Type.Object({
      criteria: Type.Array(RubricCriterionSchema),
      selection: Nullable(
        Type.Record(
          Type.String(),
          Type.Object({
            levelId: Type.String(),
            points: Type.Number(),
            comment: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
  ),
  files: Type.Array(AssignmentFileSchema),
});
export type GradeVisible = Static<typeof GradeVisibleSchema>;

export const SubmissionVersionSchema = Type.Object({
  id: Id,
  versionNo: Type.Integer(),
  submittedAt: DateTime,
  lateSeconds: Type.Integer(),
  onGrace: Type.Boolean(),
  text: Nullable(Type.String()),
  link: Nullable(Type.String()),
  penaltyPercent: Type.Number(),
  files: Type.Array(AssignmentFileSchema),
});
export type SubmissionVersion = Static<typeof SubmissionVersionSchema>;

export const DraftFileSchema = Type.Object({
  fileId: Id,
  name: Type.String(),
  size: Type.Integer(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('ready')]),
  createdAt: DateTime,
});
export type DraftFile = Static<typeof DraftFileSchema>;

export const AssignmentStateSchema = Type.Union([
  Type.Literal('not_open'),
  Type.Literal('open'),
  Type.Literal('late'),
  Type.Literal('closed'),
]);
export const AssignmentMeSchema = Type.Object({
  serverNow: DateTime,
  /** an upload begun before the due date and finalized within this many seconds counts on time */
  graceSeconds: Type.Integer(),
  assignment: Type.Object({
    itemId: Id,
    title: Type.String(),
    instructions: Nullable(RichTextSchema),
    opensAt: Nullable(DateTime),
    /** THIS learner's due date (an extension already applied) */
    dueAt: Nullable(DateTime),
    originalDueAt: Nullable(DateTime),
    hasExtension: Type.Boolean(),
    latePolicy: LatePolicySchema,
    lateCutoffAt: Nullable(DateTime),
    penaltyKind: PenaltyKindSchema,
    penaltyValue: Type.Number(),
    penaltyCap: Type.Number(),
    maxPoints: Type.Number(),
    passingScore: Nullable(Type.Number()),
    allowFile: Type.Boolean(),
    allowText: Type.Boolean(),
    allowLink: Type.Boolean(),
    maxFiles: Type.Integer(),
    maxFileMb: Type.Integer(),
    resubmissionAllowed: Type.Boolean(),
    anonymousGrading: Type.Boolean(),
    releaseMode: ReleaseModeSchema,
    attachments: Type.Array(AssignmentFileSchema),
  }),
  state: AssignmentStateSchema,
  canSubmit: Type.Boolean(),
  /** the learner has a draft upload that began before the due date and may still be handed in */
  draftWithinGrace: Type.Boolean(),
  /** what handing in RIGHT NOW would cost */
  lateSecondsNow: Type.Integer(),
  penaltyPercentNow: Type.Number(),
  penaltyPointsNow: Type.Number(),
  /** the version number that counts (the latest) */
  counts: Nullable(Type.Integer()),
  submissions: Type.Array(SubmissionVersionSchema),
  drafts: Type.Array(DraftFileSchema),
  grade: Nullable(GradeVisibleSchema),
});
export type AssignmentMe = Static<typeof AssignmentMeSchema>;

export const RequestAssignmentUploadSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  size: Type.Integer({ minimum: 1 }),
});
export const AssignmentUploadTargetSchema = Type.Object({
  fileId: Id,
  upload: UploadTargetSchema,
  maxBytes: Type.Integer(),
});

export const SubmitAssignmentRequestSchema = Type.Object({
  /** made by the browser for this hand-in: the same request sent twice is ONE version */
  requestKey: Id,
  text: Type.Optional(Type.String({ maxLength: 50000 })),
  link: Type.Optional(Type.String({ maxLength: 2000 })),
  fileIds: Type.Array(Id, { maxItems: 10 }),
  /** the learner saw the penalty of a late version that replaces an on-time one and agrees */
  confirmLate: Type.Optional(Type.Boolean()),
});
export type SubmitAssignmentRequest = Static<typeof SubmitAssignmentRequestSchema>;
export const SubmitAssignmentResponseSchema = Type.Union([
  Type.Object({
    result: Type.Literal('ok'),
    submissionId: Id,
    versionNo: Type.Integer(),
    lateSeconds: Type.Integer(),
    onGrace: Type.Boolean(),
    penaltyPercent: Type.Number(),
  }),
  Type.Object({
    result: Type.Literal('confirm_late'),
    lateSeconds: Type.Integer(),
    penaltyPercent: Type.Number(),
    penaltyPoints: Type.Number(),
    maxPoints: Type.Number(),
    currentVersionNo: Type.Integer(),
  }),
]);
export type SubmitAssignmentResponse = Static<typeof SubmitAssignmentResponseSchema>;

// ------------------------------------------------------------------ grading
export const GradingStatusSchema = Type.Union([
  Type.Literal('not_submitted'),
  Type.Literal('submitted'),
  Type.Literal('late'),
  Type.Literal('graded'),
  Type.Literal('released'),
]);
export type GradingStatus = Static<typeof GradingStatusSchema>;
export const GradingSortSchema = Type.Union([
  Type.Literal('time'),
  Type.Literal('code'),
  Type.Literal('name'),
]);

export const GradingQueueQuerySchema = Type.Object({
  status: Type.Optional(GradingStatusSchema),
  sectionId: Type.Optional(Id),
  /** `name` is refused while grading is blind (the queue then orders by code or submission time) */
  sort: Type.Optional(GradingSortSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ maxLength: 300 })),
});
export const GradingRowSchema = Type.Object({
  learnerKey: Id,
  anonCode: Type.String(),
  /** null while blind and not released */
  name: Nullable(Type.String()),
  email: Nullable(Type.String()),
  registerNumber: Nullable(Type.String()),
  sectionName: Nullable(Type.String()),
  status: GradingStatusSchema,
  versionNo: Nullable(Type.Integer()),
  submittedAt: Nullable(DateTime),
  lateSeconds: Type.Integer(),
  /** a newer version arrived after the grade */
  gradeOutdated: Type.Boolean(),
  rawScore: Nullable(Type.Number()),
  finalScore: Nullable(Type.Number()),
});
export type GradingRow = Static<typeof GradingRowSchema>;
export const GradingQueueSchema = Type.Object({
  items: Type.Array(GradingRowSchema),
  nextCursor: Nullable(Type.String()),
  blind: Type.Boolean(),
  maxPoints: Type.Number(),
});
export type GradingQueue = Static<typeof GradingQueueSchema>;

export const AssignmentGradingSummarySchema = Type.Object({
  learners: Type.Integer(),
  notSubmitted: Type.Integer(),
  submitted: Type.Integer(),
  late: Type.Integer(),
  graded: Type.Integer(),
  released: Type.Integer(),
  blind: Type.Boolean(),
});
export type AssignmentGradingSummary = Static<typeof AssignmentGradingSummarySchema>;

export const GradeInputSchema = Type.Object({
  /** the version the grader looked at: refused (409) when a newer one has arrived */
  submissionId: Id,
  /** { criterionId: { levelId, comment? } } - needed for every criterion when a rubric is attached */
  rubricSelection: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        levelId: Type.String(),
        comment: Type.Optional(Type.String({ maxLength: 1000 })),
      }),
    ),
  ),
  /** without a rubric: the score; with one: an OVERRIDE of the rubric's sum (needs `overrideReason`) */
  rawScore: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
  overrideReason: Type.Optional(Type.String({ maxLength: 500 })),
  feedback: Type.Optional(Nullable(RichTextSchema)),
  feedbackFileIds: Type.Optional(Type.Array(Id, { maxItems: 5 })),
});
export type GradeInput = Static<typeof GradeInputSchema>;

export const GradeDetailSchema = Type.Object({
  submissionId: Id,
  rubricVersionId: Nullable(Id),
  rubricSelection: Nullable(
    Type.Record(
      Type.String(),
      Type.Object({
        levelId: Type.String(),
        points: Type.Number(),
        comment: Type.Optional(Type.String()),
      }),
    ),
  ),
  rubricScore: Nullable(Type.Number()),
  rawScore: Type.Number(),
  overrideReason: Nullable(Type.String()),
  feedback: Nullable(RichTextSchema),
  penaltyPercent: Type.Number(),
  penaltyPoints: Type.Number(),
  penaltyWaived: Type.Boolean(),
  waiveReason: Nullable(Type.String()),
  finalScore: Type.Number(),
  gradedAt: DateTime,
  releasedAt: Nullable(DateTime),
  feedbackFiles: Type.Array(AssignmentFileSchema),
});
export type GradeDetail = Static<typeof GradeDetailSchema>;

export const GradeSavedSchema = Type.Object({
  submissionId: Id,
  rawScore: Type.Number(),
  penaltyPercent: Type.Number(),
  penaltyPoints: Type.Number(),
  penaltyWaived: Type.Boolean(),
  finalScore: Type.Number(),
  gradedAt: DateTime,
  releasedAt: Nullable(DateTime),
});
export type GradeSaved = Static<typeof GradeSavedSchema>;

export const GradingLearnerSchema = Type.Object({
  learnerKey: Id,
  anonCode: Type.String(),
  name: Nullable(Type.String()),
  email: Nullable(Type.String()),
  registerNumber: Nullable(Type.String()),
  blind: Type.Boolean(),
  maxPoints: Type.Number(),
  passingScore: Nullable(Type.Number()),
  rubric: Nullable(
    Type.Object({
      versionId: Id,
      title: Type.String(),
      maxPoints: Type.Number(),
      criteria: Type.Array(RubricCriterionSchema),
    }),
  ),
  /** newest first */
  submissions: Type.Array(SubmissionVersionSchema),
  grade: Nullable(GradeDetailSchema),
  /** the penalty the latest version would get now, when there is no grade yet */
  penaltyPercent: Type.Number(),
});
export type GradingLearner = Static<typeof GradingLearnerSchema>;

export const WaivePenaltyRequestSchema = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export const AssignmentReleaseRequestSchema = Type.Object({
  /** omit = every graded learner whose grade is not released yet */
  learnerKeys: Type.Optional(Type.Array(Id, { maxItems: 500 })),
});
export const AssignmentReleaseResponseSchema = Type.Object({ released: Type.Integer() });

// ------------------------------------------------------------------ what step 11 (the gradebook) consumes
export interface AssignmentFinalScore {
  itemId: string;
  participantId: string;
  rawScore: number;
  penaltyPercent: number;
  score: number;
  maxScore: number;
  percent: number;
  released: boolean;
  passingScore: number | null;
  late: boolean;
}
