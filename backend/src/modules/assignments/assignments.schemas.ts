import { Type } from '@sinclair/typebox';
import {
  AssignmentConfigSchema,
  AssignmentExtensionParamsSchema,
  AssignmentFileParamsSchema,
  AssignmentFileSchema,
  AssignmentGradingSummarySchema,
  AssignmentItemParamsSchema,
  AssignmentLearnerParamsSchema,
  AssignmentMeSchema,
  AssignmentReleaseRequestSchema,
  AssignmentReleaseResponseSchema,
  AssignmentSettingsSchema,
  AssignmentUploadTargetSchema,
  AttachRubricRequestSchema,
  COMMON_ERRORS,
  DownloadTargetSchema,
  ExtensionInputSchema,
  ExtensionSchema,
  ExtensionsSchema,
  GradeInputSchema,
  GradeSavedSchema,
  GradingLearnerSchema,
  GradingQueueQuerySchema,
  GradingQueueSchema,
  OkResponseSchema,
  ReplaceAttachmentsRequestSchema,
  RequestAssignmentUploadSchema,
  SubmitAssignmentRequestSchema,
  SubmitAssignmentResponseSchema,
  UpdateAssignmentRequestSchema,
  WaivePenaltyRequestSchema,
} from '../../contracts';

const tags = ['assignments'];
const item = AssignmentItemParamsSchema;

export const getConfigRouteSchema = {
  tags,
  summary: 'The settings, attachments and rubric of an assignment (the builder)',
  params: item,
  response: { 200: AssignmentConfigSchema, ...COMMON_ERRORS },
};
export const updateSettingsRouteSchema = {
  tags,
  summary: 'Change the settings of an assignment (audited, with before and after)',
  params: item,
  body: UpdateAssignmentRequestSchema,
  response: { 200: AssignmentSettingsSchema, ...COMMON_ERRORS },
};
export const replaceAttachmentsRouteSchema = {
  tags,
  summary: 'Replace the instructor attachments of an assignment',
  params: item,
  body: ReplaceAttachmentsRequestSchema,
  response: {
    200: Type.Object({ attachments: Type.Array(AssignmentFileSchema) }),
    ...COMMON_ERRORS,
  },
};
export const attachRubricRouteSchema = {
  tags,
  summary: 'Attach a rubric of the course (its current version is pinned) or remove it',
  params: item,
  body: AttachRubricRequestSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const listExtensionsRouteSchema = {
  tags,
  summary: 'The due-date extensions of an assignment, with their private reasons',
  params: item,
  response: { 200: ExtensionsSchema, ...COMMON_ERRORS },
};
export const setExtensionRouteSchema = {
  tags,
  summary: 'Extend the due date for one learner (the reason is private and never audited)',
  params: AssignmentExtensionParamsSchema,
  body: ExtensionInputSchema,
  response: { 200: ExtensionSchema, ...COMMON_ERRORS },
};
export const removeExtensionRouteSchema = {
  tags,
  summary: 'Remove the extension of one learner',
  params: AssignmentExtensionParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const meRouteSchema = {
  tags,
  summary:
    'The assignment as this learner sees it: their dates, versions, drafts and visible grade',
  params: item,
  response: { 200: AssignmentMeSchema, ...COMMON_ERRORS },
};
export const requestUploadRouteSchema = {
  tags,
  summary: 'Step 1 of a hand-in file: records it and returns a signed upload URL',
  params: item,
  body: RequestAssignmentUploadSchema,
  response: { 201: AssignmentUploadTargetSchema, ...COMMON_ERRORS },
};
export const confirmUploadRouteSchema = {
  tags,
  summary: 'Step 2: the bytes are checked and the file becomes ready',
  params: AssignmentFileParamsSchema,
  response: { 200: AssignmentFileSchema, ...COMMON_ERRORS },
};
export const submitRouteSchema = {
  tags,
  summary:
    'Hand in: a new version (the latest counts). A late version that replaces an on-time one needs confirmLate',
  params: item,
  body: SubmitAssignmentRequestSchema,
  response: { 200: SubmitAssignmentResponseSchema, ...COMMON_ERRORS },
};
export const learnerFileRouteSchema = {
  tags,
  summary:
    'A signed download URL for an attachment, a file of your own version or a visible feedback file',
  params: AssignmentFileParamsSchema,
  response: { 200: DownloadTargetSchema, ...COMMON_ERRORS },
};

export const queueRouteSchema = {
  tags,
  summary: 'The grading queue: one row per learner, keyset; no identity while grading is blind',
  params: item,
  querystring: GradingQueueQuerySchema,
  response: { 200: GradingQueueSchema, ...COMMON_ERRORS },
};
export const summaryRouteSchema = {
  tags,
  summary: 'How many learners are in each grading status',
  params: item,
  response: { 200: AssignmentGradingSummarySchema, ...COMMON_ERRORS },
};
export const learnerRouteSchema = {
  tags,
  summary: 'One learner for grading: every version, the rubric and the grade',
  params: AssignmentLearnerParamsSchema,
  response: { 200: GradingLearnerSchema, ...COMMON_ERRORS },
};
export const gradeRouteSchema = {
  tags,
  summary:
    'Save the grade of the latest version (rubric selection fills the score; an override needs a reason)',
  params: AssignmentLearnerParamsSchema,
  body: GradeInputSchema,
  response: { 200: GradeSavedSchema, ...COMMON_ERRORS },
};
export const waiveRouteSchema = {
  tags,
  summary: 'Waive the late penalty of a learner (reason required, audited)',
  params: AssignmentLearnerParamsSchema,
  body: WaivePenaltyRequestSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};
export const unwaiveRouteSchema = {
  tags,
  summary: 'Charge the late penalty again',
  params: AssignmentLearnerParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};
export const releaseRouteSchema = {
  tags,
  summary:
    'Release the grades of the latest versions (all, or the listed learners); the penalty is frozen',
  params: item,
  body: AssignmentReleaseRequestSchema,
  response: { 200: AssignmentReleaseResponseSchema, ...COMMON_ERRORS },
};
export const staffFileRouteSchema = {
  tags,
  summary: 'A signed download URL for any file of the assignment (graders)',
  params: AssignmentFileParamsSchema,
  response: { 200: DownloadTargetSchema, ...COMMON_ERRORS },
};
export const zipRouteSchema = {
  tags,
  summary: "Every learner's latest submission as one streamed ZIP with a CSV index",
  params: item,
  response: { 200: Type.String({ format: 'binary' }), ...COMMON_ERRORS },
};

// What a deadline receipt is bound to (core/deadline.ts): the exact content of the request that was refused busy. A retry with
// anything else changed is judged by its own arrival. A file id stands for its bytes: the SHA-256 is recorded once, at the
// confirmation of the file, and never again.
const asObject = (b: unknown): Record<string, unknown> | null =>
  typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : null;

/** the file of an upload request: its name and declared size */
export function uploadPayload(body: unknown): unknown {
  const b = asObject(body);
  return b ? { name: b.name ?? null, size: b.size ?? null } : null;
}

/** a hand-in: its request key, text, link and file ids (in order) and whether a late replacement was confirmed */
export function handInPayload(body: unknown): unknown {
  const b = asObject(body);
  if (!b) return null;
  return {
    requestKey: b.requestKey ?? null,
    text: b.text ?? null,
    link: b.link ?? null,
    fileIds: Array.isArray(b.fileIds) ? b.fileIds : [],
    confirmLate: b.confirmLate === true,
  };
}
