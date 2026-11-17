import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Notifications and email (step 13). Params are display-safe values only (titles, counts, dates): never a mark, a score,
// feedback, a reason or at-risk evidence.

export const NOTIFICATION_CATEGORIES = [
  'security',
  'learning_deadlines',
  'learning_grades',
  'learning_content',
  'teaching_grading',
  'teaching_updates',
  'admin',
] as const;
export const NotificationCategorySchema = Type.Union(
  NOTIFICATION_CATEGORIES.map((c) => Type.Literal(c)),
);
export type NotificationCategory = Static<typeof NotificationCategorySchema>;
/** categories a member may switch off (security mail is mandatory) */
export const OptionalCategorySchema = Type.Union(
  NOTIFICATION_CATEGORIES.filter((c) => c !== 'security').map((c) => Type.Literal(c)),
);
export type OptionalCategory = Static<typeof OptionalCategorySchema>;

// ------------------------------------------------------------------ in-app
export const NotificationSchema = Type.Object({
  id: Id,
  category: NotificationCategorySchema,
  type: Type.String(),
  params: Type.Record(Type.String(), Type.Unknown()),
  /** a path inside the college's site, or null */
  link: Nullable(Type.String()),
  createdAt: DateTime,
  readAt: Nullable(DateTime),
});
export type Notification = Static<typeof NotificationSchema>;

export const NotificationPageSchema = Type.Object({
  items: Type.Array(NotificationSchema),
  nextCursor: Nullable(Id),
});
export type NotificationPage = Static<typeof NotificationPageSchema>;

export const ListNotificationsQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    after: Type.Optional(Id),
    unread: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const UnreadCountSchema = Type.Object({
  /** capped at 100 ("99+") */
  unread: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type UnreadCount = Static<typeof UnreadCountSchema>;

export const MarkedSchema = Type.Object({ updated: Type.Integer({ minimum: 0 }) });

// ------------------------------------------------------------------ preferences
export const ChannelsSchema = Type.Object({ email: Type.Boolean(), inApp: Type.Boolean() });
export type Channels = Static<typeof ChannelsSchema>;

export const PreferenceSchema = Type.Object({
  category: NotificationCategorySchema,
  email: Type.Boolean(),
  inApp: Type.Boolean(),
  /** security: cannot be switched off */
  mandatory: Type.Boolean(),
  /** the college's default for this category (what "reset" goes back to) */
  collegeDefault: ChannelsSchema,
  /** true when the member chose something different from the college default */
  overridden: Type.Boolean(),
});
export type Preference = Static<typeof PreferenceSchema>;
export const PreferencesSchema = Type.Object({ items: Type.Array(PreferenceSchema) });
export type Preferences = Static<typeof PreferencesSchema>;

export const UpdatePreferenceRequestSchema = Type.Object(
  {
    category: NotificationCategorySchema,
    email: Type.Boolean(),
    inApp: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type UpdatePreferenceRequest = Static<typeof UpdatePreferenceRequestSchema>;

// ------------------------------------------------------------------ college settings (institution admins)
const HourMinute = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });
export const NotificationSettingsSchema = Type.Object({
  defaults: Type.Object({
    learning_deadlines: ChannelsSchema,
    learning_grades: ChannelsSchema,
    learning_content: ChannelsSchema,
    teaching_grading: ChannelsSchema,
    teaching_updates: ChannelsSchema,
    admin: ChannelsSchema,
  }),
  quietHours: Type.Object({ enabled: Type.Boolean(), start: HourMinute, end: HourMinute }),
  /** local hour of the daily digests and the Monday summaries */
  digestHour: Type.Integer({ minimum: 0, maximum: 23 }),
  /** display name of the From (null = the college name) */
  fromName: Nullable(Type.String({ minLength: 1, maxLength: 80 })),
  replyTo: Nullable(Type.String({ format: 'email', maxLength: 254 })),
  /** the verified From address (set by JCS on the admin host), or null = the JCS default sender */
  fromAddress: Nullable(Type.String()),
  timeZone: Type.String(),
});
export type NotificationSettings = Static<typeof NotificationSettingsSchema>;
export const UpdateNotificationSettingsRequestSchema = Type.Object(
  {
    defaults: Type.Optional(
      Type.Partial(NotificationSettingsSchema.properties.defaults, { additionalProperties: false }),
    ),
    quietHours: Type.Optional(NotificationSettingsSchema.properties.quietHours),
    digestHour: Type.Optional(NotificationSettingsSchema.properties.digestHour),
    fromName: Type.Optional(NotificationSettingsSchema.properties.fromName),
    replyTo: Type.Optional(NotificationSettingsSchema.properties.replyTo),
  },
  { additionalProperties: false },
);
export type UpdateNotificationSettingsRequest = Static<
  typeof UpdateNotificationSettingsRequestSchema
>;

// ------------------------------------------------------------------ unsubscribe (public, token based)
export const UnsubscribeTokenQuerySchema = Type.Object(
  { t: Type.String({ minLength: 10, maxLength: 600 }) },
  { additionalProperties: false },
);
export const UnsubscribeRequestSchema = Type.Object(
  { token: Type.String({ minLength: 10, maxLength: 600 }) },
  { additionalProperties: false },
);
export const UnsubscribeInfoSchema = Type.Object({
  college: Type.String(),
  emailMasked: Type.String(),
  category: OptionalCategorySchema,
  categoryLabel: Type.String(),
  subscribed: Type.Boolean(),
});
export type UnsubscribeInfo = Static<typeof UnsubscribeInfoSchema>;
export const UnsubscribeResultSchema = Type.Object({
  unsubscribed: Type.Literal(true),
  categoryLabel: Type.String(),
});

// ------------------------------------------------------------------ suppressions
export const SuppressionReasonSchema = Type.Union([
  Type.Literal('bounce'),
  Type.Literal('complaint'),
  Type.Literal('manual'),
]);
/** the signed-in member's own address: the banner */
export const MyEmailStatusSchema = Type.Object({
  email: Type.String(),
  suppressed: Type.Boolean(),
  reason: Nullable(SuppressionReasonSchema),
  since: Nullable(DateTime),
});
export type MyEmailStatus = Static<typeof MyEmailStatusSchema>;

export const SuppressionSchema = Type.Object({
  id: Id,
  email: Type.String(),
  reason: SuppressionReasonSchema,
  detail: Nullable(Type.String()),
  createdAt: DateTime,
  /** the member (college list) */
  userId: Type.Optional(Id),
  displayName: Type.Optional(Type.String()),
  /** platform list */
  provider: Type.Optional(Nullable(Type.String())),
  sourceCollege: Type.Optional(Nullable(Type.String())),
});
export type Suppression = Static<typeof SuppressionSchema>;
export const SuppressionPageSchema = Type.Object({
  items: Type.Array(SuppressionSchema),
  nextCursor: Nullable(Id),
});
export type SuppressionPage = Static<typeof SuppressionPageSchema>;

export const SetEmailSenderRequestSchema = Type.Object(
  { fromAddress: Nullable(Type.String({ format: 'email', maxLength: 254 })) },
  { additionalProperties: false },
);
