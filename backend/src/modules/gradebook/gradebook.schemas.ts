import { Type } from '@sinclair/typebox';
import {
  CategoriesSaveRequestSchema,
  COMMON_ERRORS,
  ExportQuerySchema,
  GradebookConfigSchema,
  GradebookImportParamsSchema,
  GradebookLearnerParamsSchema,
  GradebookParamsSchema,
  GradebookSettingsSchema,
  GradeScaleArchiveRequestSchema,
  GradeScaleInputSchema,
  GradeScaleListQuerySchema,
  GradeScaleListSchema,
  GradeScaleParamsSchema,
  GradeScaleSchema,
  GridQuerySchema,
  GridSchema,
  ItemsSaveRequestSchema,
  LearnerExplanationSchema,
  LearnerGradesSchema,
  MarkImportApplyRequestSchema,
  MarkImportApplyResponseSchema,
  MarkImportRequestSchema,
  MarkImportSummarySchema,
  MarksSaveRequestSchema,
  MarksSaveResponseSchema,
  OverrideRequestSchema,
  OverrideRevokeQuerySchema,
  QueueQuerySchema,
  QueueSchema,
  ResultSchemaOk,
  ReturnRequestSchema,
  ReviewRequestSchema,
  ReviewSchema,
  SettingsPatchSchema,
  UnlockRequestSchema,
  WorkflowResultSchema,
} from '../../contracts';

const tags = ['gradebook'];
const offering = GradebookParamsSchema;

export const configRouteSchema = {
  tags,
  summary: 'The gradebook of an offering: structure, status, history, items that could be added',
  params: offering,
  response: { 200: GradebookConfigSchema, ...COMMON_ERRORS },
};
export const reviewRouteSchema = {
  tags,
  summary:
    'What an approver needs: structure, problems, who is not in the snapshot, the outcome in numbers',
  params: offering,
  response: { 200: ReviewSchema, ...COMMON_ERRORS },
};
export const settingsRouteSchema = {
  tags,
  summary:
    'Change weighting, the out-of total, rounding, the grade scale, the export layout (draft or returned only)',
  params: offering,
  body: SettingsPatchSchema,
  response: { 200: GradebookConfigSchema, ...COMMON_ERRORS },
};
export const categoriesRouteSchema = {
  tags,
  summary: 'Save the categories (weights, drop lowest, missing-work policy) in display order',
  params: offering,
  body: CategoriesSaveRequestSchema,
  response: { 200: GradebookConfigSchema, ...COMMON_ERRORS },
};
export const itemsRouteSchema = {
  tags,
  summary:
    'Save the items: assessments and assignments of the offering, and manual columns; omitted items are archived',
  params: offering,
  body: ItemsSaveRequestSchema,
  response: { 200: GradebookConfigSchema, ...COMMON_ERRORS },
};
export const gridRouteSchema = {
  tags,
  summary:
    'A chunk of the grid: learners x items with category totals and the final (keyset by register number)',
  params: offering,
  querystring: GridQuerySchema,
  response: { 200: GridSchema, ...COMMON_ERRORS },
};
export const learnerRouteSchema = {
  tags,
  summary: 'How the final of one learner was calculated, with their overrides',
  params: GradebookLearnerParamsSchema,
  response: { 200: LearnerExplanationSchema, ...COMMON_ERRORS },
};
export const marksRouteSchema = {
  tags,
  summary:
    'Enter manual marks in a batch (a cell with a stale expected value is reported, not overwritten)',
  params: offering,
  body: MarksSaveRequestSchema,
  response: { 200: MarksSaveResponseSchema, ...COMMON_ERRORS },
};
export const importStageRouteSchema = {
  tags,
  summary: 'Dry run of a marks CSV (matched by register number): nothing is written',
  params: offering,
  body: MarkImportRequestSchema,
  response: { 201: MarkImportSummarySchema, ...COMMON_ERRORS },
};
export const importGetRouteSchema = {
  tags,
  summary: 'The dry run of a marks import, with its errors',
  params: GradebookImportParamsSchema,
  response: { 200: MarkImportSummarySchema, ...COMMON_ERRORS },
};
export const importApplyRouteSchema = {
  tags,
  summary: 'Apply a staged marks import (rows with errors need skipInvalid)',
  params: GradebookImportParamsSchema,
  body: MarkImportApplyRequestSchema,
  response: { 200: MarkImportApplyResponseSchema, ...COMMON_ERRORS },
};
export const overrideSetRouteSchema = {
  tags,
  summary: 'Override the mark of one learner in an item (or the final) with a reason; audited',
  params: GradebookLearnerParamsSchema,
  body: OverrideRequestSchema,
  response: { 200: ResultSchemaOk, ...COMMON_ERRORS },
};
export const overrideRevokeRouteSchema = {
  tags,
  summary: 'Remove an override (the history is kept)',
  params: GradebookLearnerParamsSchema,
  querystring: OverrideRevokeQuerySchema,
  response: { 200: ResultSchemaOk, ...COMMON_ERRORS },
};
export const submitRouteSchema = {
  tags,
  summary:
    'Submit the gradebook for approval (refused with the list of problems when it is not ready)',
  params: offering,
  response: { 200: WorkflowResultSchema, ...COMMON_ERRORS },
};
export const approveRouteSchema = {
  tags,
  summary:
    'Approve a submitted gradebook: locks it and freezes an immutable snapshot of every learner',
  params: offering,
  body: ReviewRequestSchema,
  response: { 200: WorkflowResultSchema, ...COMMON_ERRORS },
};
export const returnRouteSchema = {
  tags,
  summary: 'Return a submitted gradebook to the instructor with a comment',
  params: offering,
  body: ReturnRequestSchema,
  response: { 200: WorkflowResultSchema, ...COMMON_ERRORS },
};
export const unlockRouteSchema = {
  tags,
  summary:
    'Unlock a locked gradebook (reason required, audited): starts the next version, the old snapshot stays',
  params: offering,
  body: UnlockRequestSchema,
  response: { 200: WorkflowResultSchema, ...COMMON_ERRORS },
};
export const exportRouteSchema = {
  tags,
  summary: 'Export the approved snapshot as a file (the configured column layout)',
  params: offering,
  querystring: ExportQuerySchema,
  response: { 200: Type.String({ format: 'binary' }), ...COMMON_ERRORS },
};
export const meRouteSchema = {
  tags,
  summary: 'My grades: released items and a provisional final, or the approved record',
  params: offering,
  response: { 200: LearnerGradesSchema, ...COMMON_ERRORS },
};
export const queueRouteSchema = {
  tags,
  summary: 'The approval queue of the college (keyset)',
  querystring: QueueQuerySchema,
  response: { 200: QueueSchema, ...COMMON_ERRORS },
};
export const collegeSettingsGetRouteSchema = {
  tags,
  summary: 'The gradebook settings of the college',
  response: { 200: GradebookSettingsSchema, ...COMMON_ERRORS },
};
export const collegeSettingsPatchRouteSchema = {
  tags,
  summary: 'Allow or forbid self-approval of gradebooks (audited)',
  body: GradebookSettingsSchema,
  response: { 200: GradebookSettingsSchema, ...COMMON_ERRORS },
};
export const scalesListRouteSchema = {
  tags,
  summary: 'The grade scales of the college',
  querystring: GradeScaleListQuerySchema,
  response: { 200: GradeScaleListSchema, ...COMMON_ERRORS },
};
export const scaleCreateRouteSchema = {
  tags,
  summary: 'Create a grade scale (percentage bands)',
  body: GradeScaleInputSchema,
  response: { 201: GradeScaleSchema, ...COMMON_ERRORS },
};
export const scaleUpdateRouteSchema = {
  tags,
  summary: 'Change a grade scale (locked snapshots keep their own copy of the bands)',
  params: GradeScaleParamsSchema,
  body: GradeScaleInputSchema,
  response: { 200: GradeScaleSchema, ...COMMON_ERRORS },
};
export const scaleArchiveRouteSchema = {
  tags,
  summary: 'Archive or restore a grade scale',
  params: GradeScaleParamsSchema,
  body: GradeScaleArchiveRequestSchema,
  response: { 200: GradeScaleSchema, ...COMMON_ERRORS },
};
