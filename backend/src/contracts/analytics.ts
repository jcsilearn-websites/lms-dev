import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Dashboards, reports, at-risk learners and usage (step 12). Every number comes from the rollups (with a "data as of" time) or from a
// small bounded live statement; nothing here is a score or a ranking of a person.

// ------------------------------------------------------------------ college settings
export const AtRiskSettingsSchema = Type.Object({
  /** behind on required items: uses each offering's own "behind after N days" setting */
  behindEnabled: Type.Boolean(),
  missedDeadlinesEnabled: Type.Boolean(),
  /** flagged at this many missed deadlines or more */
  missedDeadlines: Type.Integer({ minimum: 1, maximum: 20 }),
  lowScoreEnabled: Type.Boolean(),
  /** average of the RELEASED scores, percent; below this = flagged */
  passMarkPercent: Type.Number({ minimum: 1, maximum: 100 }),
  inactiveEnabled: Type.Boolean(),
  inactiveDays: Type.Integer({ minimum: 1, maximum: 120 }),
});
export type AtRiskSettings = Static<typeof AtRiskSettingsSchema>;

export const AnalyticsSettingsSchema = Type.Object({
  /** IANA zone name; every day / week / month bucket and every displayed date uses it */
  timeZone: Type.String({ minLength: 1, maxLength: 64 }),
  atRisk: AtRiskSettingsSchema,
  /** "Needs attention" (course health) is shown to institution admins at all */
  showCourseHealth: Type.Boolean(),
  /** an offering with no new content for this many weeks is listed ... */
  courseHealthWeeks: Type.Integer({ minimum: 1, maximum: 26 }),
  /** ... and one whose oldest ungraded work has waited longer than this many days */
  courseHealthBacklogDays: Type.Integer({ minimum: 1, maximum: 90 }),
  /** billable learner = active on at least this many days of the month ... */
  usageMinActiveDays: Type.Integer({ minimum: 1, maximum: 31 }),
  /** ... and (when true) a learner of at least one offering */
  usageLearnersOnly: Type.Boolean(),
});
export type AnalyticsSettings = Static<typeof AnalyticsSettingsSchema>;
export const UpdateAnalyticsSettingsRequestSchema = Type.Partial(
  Type.Object({
    timeZone: AnalyticsSettingsSchema.properties.timeZone,
    atRisk: Type.Partial(AtRiskSettingsSchema),
    showCourseHealth: AnalyticsSettingsSchema.properties.showCourseHealth,
    courseHealthWeeks: AnalyticsSettingsSchema.properties.courseHealthWeeks,
    courseHealthBacklogDays: AnalyticsSettingsSchema.properties.courseHealthBacklogDays,
    usageMinActiveDays: AnalyticsSettingsSchema.properties.usageMinActiveDays,
    usageLearnersOnly: AnalyticsSettingsSchema.properties.usageLearnersOnly,
  }),
  { additionalProperties: false },
);
export type UpdateAnalyticsSettingsRequest = Static<typeof UpdateAnalyticsSettingsRequestSchema>;

// ------------------------------------------------------------------ learner dashboard
export const UpcomingKindSchema = Type.Union([
  Type.Literal('assignment_due'),
  Type.Literal('assessment_closes'),
  Type.Literal('assessment_opens'),
  Type.Literal('item_available'),
]);
const DashboardEntrySchema = Type.Object({
  kind: Type.String(),
  offeringId: Id,
  offeringTitle: Type.String(),
  itemId: Id,
  title: Type.String(),
  at: DateTime,
});
export const LearnerDashboardSchema = Type.Object({
  timeZone: Type.String(),
  today: Day,
  upcoming: Type.Array(DashboardEntrySchema),
  /** names only: the grade itself is on the item's page */
  released: Type.Array(DashboardEntrySchema),
  resume: Nullable(
    Type.Object({
      offeringId: Id,
      offeringTitle: Type.String(),
      itemId: Id,
      title: Type.String(),
    }),
  ),
  /** the days (Monday to Sunday) of this local week; private to the learner */
  week: Type.Array(Type.Object({ date: Day, active: Type.Boolean() })),
  streak: Type.Integer(),
});
export type LearnerDashboard = Static<typeof LearnerDashboardSchema>;

// ------------------------------------------------------------------ instructor dashboards
export const OfferingDashboardSchema = Type.Object({
  timeZone: Type.String(),
  /** when the rollups behind the recent-activity chart were last brought up to date; null = never */
  asOf: Nullable(DateTime),
  learners: Type.Integer(),
  backlog: Type.Object({
    /** latest hand-ins without a grade */
    submissions: Type.Integer(),
    /** attempts with answers a person still has to grade */
    attempts: Type.Integer(),
  }),
  upcoming: Type.Array(DashboardEntrySchema),
  funnel: Type.Array(
    Type.Object({
      moduleId: Id,
      title: Type.String(),
      requiredItems: Type.Integer(),
      started: Type.Integer(),
      completed: Type.Integer(),
    }),
  ),
  assessments: Type.Array(
    Type.Object({
      itemId: Id,
      title: Type.String(),
      attempts: Type.Integer(),
      learners: Type.Integer(),
      averagePercent: Nullable(Type.Number()),
      passRatePercent: Nullable(Type.Number()),
    }),
  ),
  atRiskCount: Type.Integer(),
  recent: Type.Array(
    Type.Object({
      day: Day,
      activeLearners: Type.Integer(),
      itemsCompleted: Type.Integer(),
      submissions: Type.Integer(),
      attempts: Type.Integer(),
    }),
  ),
});
export type OfferingDashboard = Static<typeof OfferingDashboardSchema>;

export const TeachingDashboardSchema = Type.Object({
  timeZone: Type.String(),
  asOf: Nullable(DateTime),
  offerings: Type.Array(
    Type.Object({
      offeringId: Id,
      title: Type.String(),
      participation: Type.Union([Type.Literal('instructor'), Type.Literal('assistant')]),
      learners: Type.Integer(),
      averageProgressPercent: Nullable(Type.Number()),
      backlogSubmissions: Type.Integer(),
      backlogAttempts: Type.Integer(),
      atRiskCount: Type.Integer(),
      nextDeadline: Nullable(DateTime),
    }),
  ),
});
export type TeachingDashboard = Static<typeof TeachingDashboardSchema>;

export const VideoEngagementSchema = Type.Object({
  itemId: Id,
  title: Type.String(),
  durationSeconds: Type.Integer(),
  learners: Type.Integer(),
  started: Type.Integer(),
  /** each segment: the share of ALL active learners whose watched ranges cover the middle of the segment */
  segments: Type.Array(
    Type.Object({
      fromSecond: Type.Integer(),
      toSecond: Type.Integer(),
      percent: Type.Number(),
    }),
  ),
});
export type VideoEngagement = Static<typeof VideoEngagementSchema>;
export const VideoEngagementParamsSchema = Type.Object({ id: Id, itemId: Id });

// ------------------------------------------------------------------ at-risk
export const AtRiskRuleSchema = Type.Union([
  Type.Literal('behind'),
  Type.Literal('missed_deadlines'),
  Type.Literal('low_score'),
  Type.Literal('inactive'),
]);
export type AtRiskRule = Static<typeof AtRiskRuleSchema>;
export const AtRiskLearnerSchema = Type.Object({
  participantId: Id,
  displayName: Type.String(),
  email: Type.String(),
  /** every rule that fired, with the evidence in words */
  rules: Type.Array(
    Type.Object({
      rule: AtRiskRuleSchema,
      summary: Type.String(),
      evidence: Type.Array(Type.String()),
    }),
  ),
});
export const AtRiskPageSchema = Type.Object({
  asOf: Nullable(DateTime),
  timeZone: Type.String(),
  settings: AtRiskSettingsSchema,
  items: Type.Array(AtRiskLearnerSchema),
  total: Type.Integer(),
  nextCursor: Nullable(Type.String()),
});
export type AtRiskPage = Static<typeof AtRiskPageSchema>;
export const AtRiskQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ maxLength: 100 })),
});

// ------------------------------------------------------------------ college reports: one generic table
export const REPORT_TABLES = [
  'activity',
  'organisation',
  'course-health',
  'gradebooks',
  'grading-backlog',
  'at-risk',
  'resources',
] as const;
export const ReportTableIdSchema = Type.Union(REPORT_TABLES.map((t) => Type.Literal(t)));
export type ReportTableId = Static<typeof ReportTableIdSchema>;
export const ReportColumnSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  kind: Type.Union([
    Type.Literal('text'),
    Type.Literal('number'),
    Type.Literal('percent'),
    Type.Literal('date'),
    Type.Literal('datetime'),
    Type.Literal('bytes'),
  ]),
});
export const ReportTableSchema = Type.Object({
  id: ReportTableIdSchema,
  title: Type.String(),
  /** one sentence a reader (and a screen reader) gets before the numbers */
  summary: Type.String(),
  asOf: Nullable(DateTime),
  timeZone: Type.String(),
  columns: Type.Array(ReportColumnSchema),
  rows: Type.Array(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])),
  ),
  /** true when the table was cut at the row limit */
  truncated: Type.Boolean(),
});
export type ReportTable = Static<typeof ReportTableSchema>;
export const ReportParamsSchema = Type.Object({ table: ReportTableIdSchema });
export const ReportQuerySchema = Type.Object({
  /** organisation: which level */
  scope: Type.Optional(
    Type.Union([
      Type.Literal('department'),
      Type.Literal('program'),
      Type.Literal('batch'),
      Type.Literal('section'),
    ]),
  ),
  /** activity: how many local days (default 30) */
  days: Type.Optional(Type.Integer({ minimum: 7, maximum: 180 })),
});
export const ReportExportQuerySchema = Type.Composite([
  ReportQuerySchema,
  Type.Object({ format: Type.Union([Type.Literal('csv'), Type.Literal('xlsx')]) }),
]);
export const ActiveUsersSchema = Type.Object({
  timeZone: Type.String(),
  today: Day,
  dau: Type.Integer(),
  wau: Type.Integer(),
  mau: Type.Integer(),
  asOf: Nullable(DateTime),
});
export type ActiveUsers = Static<typeof ActiveUsersSchema>;

// ------------------------------------------------------------------ platform usage
export const UsageRowSchema = Type.Object({
  tenantId: Id,
  slug: Type.String(),
  name: Type.String(),
  status: Type.String(),
  /** the month is still open: computed now, not frozen */
  provisional: Type.Boolean(),
  revision: Type.Integer(),
  timeZone: Type.String(),
  billableLearners: Type.Integer(),
  activeUsers: Type.Integer(),
  videoHours: Type.Number(),
  videoGbEstimate: Type.Number(),
  storageGb: Type.Number(),
  offerings: Type.Integer(),
  activeOfferings: Type.Integer(),
  members: Type.Integer(),
});
export type UsageRow = Static<typeof UsageRowSchema>;
export const UsageQuerySchema = Type.Object({
  /** first day of the month, YYYY-MM-01; default: the current month */
  month: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-01$' })),
});
export const UsageExportQuerySchema = Type.Composite([
  UsageQuerySchema,
  Type.Object({ format: Type.Union([Type.Literal('csv'), Type.Literal('xlsx')]) }),
]);
export const UsageResponseSchema = Type.Object({
  month: Day,
  rows: Type.Array(UsageRowSchema),
  renditionMix: Type.Record(Type.String(), Type.Number()),
  note: Type.String(),
});
export type UsageResponse = Static<typeof UsageResponseSchema>;
