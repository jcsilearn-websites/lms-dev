import {
  AccommodationInputSchema,
  AccommodationParamsSchema,
  AccommodationSchema,
  AccommodationsSchema,
  AnalysisSchema,
  AssessmentConfigSchema,
  AssessmentItemParamsSchema,
  AssessmentMeSchema,
  AssessmentSettingsSchema,
  AttemptFileParamsSchema,
  AttemptListQuerySchema,
  AttemptPageSchema,
  AttemptParamsSchema,
  AttemptQuestionParamsSchema,
  AttemptSchema,
  COMMON_ERRORS,
  DownloadTargetSchema,
  FeedbackRequestSchema,
  GradeRequestSchema,
  GradeResponseSchema,
  GradingAnswersQuerySchema,
  GradingAnswersSchema,
  GradingSummarySchema,
  OkResponseSchema,
  PreviewSchema,
  RegradeHistorySchema,
  RegradeRequestSchema,
  RegradeResponseSchema,
  ReleaseRequestSchema,
  ReleaseResponseSchema,
  ReplaceSlotsRequestSchema,
  ReplaceSlotsResponseSchema,
  ResultSchema,
  SaveRequestSchema,
  SaveResponseSchema,
  ScriptSchema,
  StartAttemptResponseSchema,
  SubmitResponseSchema,
  UpdateSettingsRequestSchema,
} from '../../contracts';

const tags = ['assessments'];
const item = AssessmentItemParamsSchema;

export const getConfigRouteSchema = {
  tags,
  summary: 'The settings and questions of an assessment (the builder)',
  params: item,
  response: { 200: AssessmentConfigSchema, ...COMMON_ERRORS },
};
export const updateSettingsRouteSchema = {
  tags,
  summary: 'Change the settings of an assessment',
  params: item,
  body: UpdateSettingsRequestSchema,
  response: { 200: AssessmentSettingsSchema, ...COMMON_ERRORS },
};
export const replaceSlotsRouteSchema = {
  tags,
  summary: 'Replace the questions of an assessment: fixed questions and random pools',
  params: item,
  body: ReplaceSlotsRequestSchema,
  response: { 200: ReplaceSlotsResponseSchema, ...COMMON_ERRORS },
};
export const previewRouteSchema = {
  tags,
  summary: 'One sample paper as a learner would get it (no answers); nothing is stored',
  params: item,
  response: { 200: PreviewSchema, ...COMMON_ERRORS },
};

export const listAccommodationsRouteSchema = {
  tags,
  summary: 'The accommodations of an assessment (sensitive: instructors and administrators only)',
  params: item,
  response: { 200: AccommodationsSchema, ...COMMON_ERRORS },
};
export const setAccommodationRouteSchema = {
  tags,
  summary: 'Give a learner extra time and / or a later close date (audited without the reason)',
  params: AccommodationParamsSchema,
  body: AccommodationInputSchema,
  response: { 200: AccommodationSchema, ...COMMON_ERRORS },
};
export const removeAccommodationRouteSchema = {
  tags,
  summary: 'Remove a learner accommodation',
  params: AccommodationParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const meRouteSchema = {
  tags,
  summary: 'The learner page of an assessment: rules, my attempts, what I may see',
  params: item,
  response: { 200: AssessmentMeSchema, ...COMMON_ERRORS },
};
export const startRouteSchema = {
  tags,
  summary: 'Start an attempt (or get the active one back)',
  params: item,
  response: { 200: StartAttemptResponseSchema, ...COMMON_ERRORS },
};
export const readAttemptRouteSchema = {
  tags,
  summary:
    'The active attempt: questions without answers, saved answers and revisions, the server deadline',
  params: AttemptParamsSchema,
  response: { 200: AttemptSchema, ...COMMON_ERRORS },
};
export const saveRouteSchema = {
  tags,
  summary: 'Autosave changed answers (a batch) and integrity events',
  params: AttemptParamsSchema,
  body: SaveRequestSchema,
  response: { 200: SaveResponseSchema, ...COMMON_ERRORS },
};
export const submitRouteSchema = {
  tags,
  summary: 'Hand in the attempt (safe to repeat)',
  params: AttemptParamsSchema,
  response: { 200: SubmitResponseSchema, ...COMMON_ERRORS },
};
export const resultRouteSchema = {
  tags,
  summary: 'The result of an attempt, as far as the assessment lets the learner see it',
  params: AttemptParamsSchema,
  response: { 200: ResultSchema, ...COMMON_ERRORS },
};
export const attemptImageRouteSchema = {
  tags,
  summary: 'A signed download URL for an image shown in the learner own attempt',
  params: AttemptFileParamsSchema,
  response: { 200: DownloadTargetSchema, ...COMMON_ERRORS },
};

export const listAttemptsRouteSchema = {
  tags,
  summary: 'The attempts of an assessment (keyset, newest first)',
  params: item,
  querystring: AttemptListQuerySchema,
  response: { 200: AttemptPageSchema, ...COMMON_ERRORS },
};
export const gradingSummaryRouteSchema = {
  tags,
  summary: 'Questions with answers waiting for a grade, and how many',
  params: item,
  response: { 200: GradingSummarySchema, ...COMMON_ERRORS },
};
export const gradingAnswersRouteSchema = {
  tags,
  summary: 'The answers to one question, to grade across students (keyset)',
  params: item,
  querystring: GradingAnswersQuerySchema,
  response: { 200: GradingAnswersSchema, ...COMMON_ERRORS },
};
export const scriptRouteSchema = {
  tags,
  summary: 'One attempt as the instructor sees it: answers, keys, marks, feedback, integrity log',
  params: AttemptParamsSchema,
  response: { 200: ScriptSchema, ...COMMON_ERRORS },
};
export const gradeRouteSchema = {
  tags,
  summary: 'Grade one answer (points and feedback)',
  params: AttemptQuestionParamsSchema,
  body: GradeRequestSchema,
  response: { 200: GradeResponseSchema, ...COMMON_ERRORS },
};
export const feedbackRouteSchema = {
  tags,
  summary: 'Write feedback for the whole attempt',
  params: AttemptParamsSchema,
  body: FeedbackRequestSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};
export const regradeRouteSchema = {
  tags,
  summary:
    'Re-score every attempt that showed a question (rekey, drop or credit); dryRun shows before / after only',
  params: item,
  body: RegradeRequestSchema,
  response: { 200: RegradeResponseSchema, ...COMMON_ERRORS },
};
export const regradesRouteSchema = {
  tags,
  summary: 'The regrades done on an assessment',
  params: item,
  response: { 200: RegradeHistorySchema, ...COMMON_ERRORS },
};
export const releaseRouteSchema = {
  tags,
  summary:
    'Release the results of graded attempts (for assessments whose results are released by hand)',
  params: item,
  body: ReleaseRequestSchema,
  response: { 200: ReleaseResponseSchema, ...COMMON_ERRORS },
};
export const analysisRouteSchema = {
  tags,
  summary: 'Item analysis: percent correct, option distribution, average score and time',
  params: item,
  response: { 200: AnalysisSchema, ...COMMON_ERRORS },
};
