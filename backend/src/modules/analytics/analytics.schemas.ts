import {
  ActiveUsersSchema,
  AnalyticsSettingsSchema,
  AtRiskPageSchema,
  AtRiskQuerySchema,
  COMMON_ERRORS,
  LearnerDashboardSchema,
  OfferingDashboardSchema,
  OfferingParamsSchema,
  ReportExportQuerySchema,
  ReportParamsSchema,
  ReportQuerySchema,
  ReportTableSchema,
  TeachingDashboardSchema,
  UpdateAnalyticsSettingsRequestSchema,
  VideoEngagementParamsSchema,
  VideoEngagementSchema,
} from '../../contracts';

const tags = ['analytics'];

export const learnerDashboardRouteSchema = {
  tags,
  summary:
    'My dashboard: what is coming up, released grades, where to continue, this week (private to me)',
  response: { 200: LearnerDashboardSchema, ...COMMON_ERRORS },
};
export const teachingDashboardRouteSchema = {
  tags,
  summary: 'The offerings I teach or assist: learners, progress, grading backlog, flagged learners',
  response: { 200: TeachingDashboardSchema, ...COMMON_ERRORS },
};
export const offeringDashboardRouteSchema = {
  tags,
  summary: 'One offering: grading backlog, upcoming, module funnel, assessments, recent activity',
  params: OfferingParamsSchema,
  response: { 200: OfferingDashboardSchema, ...COMMON_ERRORS },
};
export const videoEngagementRouteSchema = {
  tags,
  summary: 'Per-video drop-off: the share of learners who watched each segment (aggregate only)',
  params: VideoEngagementParamsSchema,
  response: { 200: VideoEngagementSchema, ...COMMON_ERRORS },
};
export const atRiskRouteSchema = {
  tags,
  summary:
    'Learners flagged by the at-risk rules, with the rules that fired and their evidence (staff only)',
  params: OfferingParamsSchema,
  querystring: AtRiskQuerySchema,
  response: { 200: AtRiskPageSchema, ...COMMON_ERRORS },
};
export const atRiskCsvRouteSchema = {
  tags,
  summary: 'The flagged learners as a CSV file (one line per rule, formula-injection safe)',
  params: OfferingParamsSchema,
  response: { ...COMMON_ERRORS },
};
export const atRiskXlsxRouteSchema = {
  tags,
  summary: 'The flagged learners as an XLSX file',
  params: OfferingParamsSchema,
  response: { ...COMMON_ERRORS },
};
export const getSettingsRouteSchema = {
  tags,
  summary: 'The college time zone, at-risk rules, course-health window and billing definition',
  response: { 200: AnalyticsSettingsSchema, ...COMMON_ERRORS },
};
export const updateSettingsRouteSchema = {
  tags,
  summary: 'Change the college time zone and the analytics rules (audited with before and after)',
  body: UpdateAnalyticsSettingsRequestSchema,
  response: { 200: AnalyticsSettingsSchema, ...COMMON_ERRORS },
};
export const activeUsersRouteSchema = {
  tags,
  summary: 'Daily, weekly and monthly active users (college time zone)',
  response: { 200: ActiveUsersSchema, ...COMMON_ERRORS },
};
export const reportRouteSchema = {
  tags,
  summary: 'One college report table (columns, rows, summary sentence, data as of)',
  params: ReportParamsSchema,
  querystring: ReportQuerySchema,
  response: { 200: ReportTableSchema, ...COMMON_ERRORS },
};
export const reportExportRouteSchema = {
  tags,
  summary: 'A report table as CSV or XLSX (at most 100,000 rows)',
  params: ReportParamsSchema,
  querystring: ReportExportQuerySchema,
  response: { ...COMMON_ERRORS },
};
