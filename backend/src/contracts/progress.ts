import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Learning progress (step 8). Watched time is the UNIQUE seconds played, merged by the server.

export const ItemStatusSchema = Type.Union([
  Type.Literal('not_started'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
]);
export type ItemStatus = Static<typeof ItemStatusSchema>;

// ------------------------------------------------------------------ heartbeat
export const MAX_HEARTBEAT_RANGES = 16;

export const HeartbeatRequestSchema = Type.Object({
  /** the video the player is playing (a replaced video makes an old player's heartbeats stale) */
  videoId: Id,
  /** one random id per player instance: its heartbeat numbers are only compared with each other */
  streamId: Id,
  /** 1, 2, 3 ... per stream; a number that is not higher than the last one is a duplicate */
  seq: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  /** the media-time ranges [from, to) in seconds that were PLAYED since the last heartbeat */
  ranges: Type.Array(Type.Tuple([Type.Number({ minimum: 0 }), Type.Number({ minimum: 0 })]), {
    maxItems: MAX_HEARTBEAT_RANGES,
  }),
  /** where the viewer is now, in seconds */
  position: Type.Number({ minimum: 0, maximum: 100_000 }),
  /** the playback speed */
  rate: Type.Number({ minimum: 0.25, maximum: 4 }),
});
export type HeartbeatRequest = Static<typeof HeartbeatRequestSchema>;

export const HeartbeatResponseSchema = Type.Object({
  /** ok | duplicate (nothing changed) */
  result: Type.Union([Type.Literal('ok'), Type.Literal('duplicate')]),
  watchedSeconds: Type.Integer(),
  durationSeconds: Type.Integer(),
  /** unique watched share of the video, 0..100 */
  percent: Type.Integer(),
  completed: Type.Boolean(),
  positionSeconds: Type.Integer(),
});
export type HeartbeatResponse = Static<typeof HeartbeatResponseSchema>;

export const ItemProgressParamsSchema = Type.Object({ id: Id, itemId: Id });

export const MarkResponseSchema = Type.Object({ status: ItemStatusSchema });
export type MarkResponse = Static<typeof MarkResponseSchema>;

// ------------------------------------------------------------------ a learner's own progress
export const ProgressItemSchema = Type.Object({
  itemId: Id,
  moduleId: Id,
  status: ItemStatusSchema,
  required: Type.Boolean(),
  /** video: unique watched share, 0..100 (null for other kinds) */
  watchedPercent: Nullable(Type.Integer()),
  positionSeconds: Nullable(Type.Integer()),
});
export const ProgressModuleSchema = Type.Object({
  moduleId: Id,
  completedRequired: Type.Integer(),
  totalRequired: Type.Integer(),
  /** null when the module has no required item yet */
  percent: Nullable(Type.Integer()),
});
export const ResumeSchema = Type.Object({
  offeringId: Id,
  offeringTitle: Type.String(),
  itemId: Id,
  itemTitle: Type.String(),
  kind: Type.String(),
  positionSeconds: Type.Integer(),
  lastActivityAt: DateTime,
});

export const MyProgressSchema = Type.Object({
  /** false for someone who is not a learner of this offering (they have no progress) */
  participant: Type.Boolean(),
  completedRequired: Type.Integer(),
  totalRequired: Type.Integer(),
  percent: Nullable(Type.Integer()),
  modules: Type.Array(ProgressModuleSchema),
  items: Type.Array(ProgressItemSchema),
  resume: Nullable(ResumeSchema),
});
export type MyProgress = Static<typeof MyProgressSchema>;

export const MyOfferingsProgressSchema = Type.Object({
  offerings: Type.Array(
    Type.Object({
      offeringId: Id,
      completedRequired: Type.Integer(),
      totalRequired: Type.Integer(),
      percent: Nullable(Type.Integer()),
    }),
  ),
  /** where to continue: the last item the learner left unfinished, in any course */
  resume: Nullable(ResumeSchema),
});
export type MyOfferingsProgress = Static<typeof MyOfferingsProgressSchema>;

// ------------------------------------------------------------------ the class view
export const CLASS_STATUSES = ['not_started', 'in_progress', 'behind', 'completed'] as const;
export const ClassStatusSchema = Type.Union([
  Type.Literal('not_started'),
  Type.Literal('in_progress'),
  Type.Literal('behind'),
  Type.Literal('completed'),
]);
export type ClassStatus = Static<typeof ClassStatusSchema>;

export const ClassQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ maxLength: 300 })),
  section: Type.Optional(Id),
  status: Type.Optional(
    Type.Union([
      Type.Literal('not_started'),
      Type.Literal('in_progress'),
      Type.Literal('behind'),
      Type.Literal('completed'),
    ]),
  ),
  /** active learners (default) or the read-only history of removed ones */
  learners: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('removed')])),
  sort: Type.Optional(
    Type.Union([Type.Literal('name'), Type.Literal('percent'), Type.Literal('activity')]),
  ),
  dir: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
});

export const ClassRowSchema = Type.Object({
  participantId: Id,
  userId: Id,
  displayName: Type.String(),
  email: Type.String(),
  sectionName: Nullable(Type.String()),
  removed: Type.Boolean(),
  completedRequired: Type.Integer(),
  totalRequired: Type.Integer(),
  percent: Nullable(Type.Integer()),
  status: ClassStatusSchema,
  lastActivityAt: Nullable(DateTime),
  modules: Type.Array(Type.Object({ moduleId: Id, percent: Nullable(Type.Integer()) })),
});
export type ClassRow = Static<typeof ClassRowSchema>;

export const ClassPageSchema = Type.Object({
  modules: Type.Array(Type.Object({ id: Id, title: Type.String() })),
  items: Type.Array(ClassRowSchema),
  nextCursor: Nullable(Type.String()),
  /** learners matching the filters (not only this page) */
  total: Type.Integer(),
});
export type ClassPage = Static<typeof ClassPageSchema>;

export const LearnerParamsSchema = Type.Object({ id: Id, participantId: Id });

export const LearnerDrilldownSchema = Type.Object({
  learner: Type.Object({
    participantId: Id,
    displayName: Type.String(),
    email: Type.String(),
    removed: Type.Boolean(),
    completedRequired: Type.Integer(),
    totalRequired: Type.Integer(),
    percent: Nullable(Type.Integer()),
  }),
  items: Type.Array(
    Type.Object({
      itemId: Id,
      moduleId: Id,
      moduleTitle: Type.String(),
      title: Type.String(),
      kind: Type.String(),
      required: Type.Boolean(),
      status: ItemStatusSchema,
      watchedPercent: Nullable(Type.Integer()),
      watchedSeconds: Nullable(Type.Integer()),
      durationSeconds: Nullable(Type.Integer()),
      completedAt: Nullable(DateTime),
      completedHow: Nullable(Type.String()),
      lastActivityAt: Nullable(DateTime),
      /** heartbeats that claimed more than is physically possible (instructors only) */
      flagged: Type.Integer(),
    }),
  ),
});
export type LearnerDrilldown = Static<typeof LearnerDrilldownSchema>;
