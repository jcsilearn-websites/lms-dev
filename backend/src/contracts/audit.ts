import { type Static, Type } from '@sinclair/typebox';

const Uuid = Type.String({ format: 'uuid' });

export const AuditEntrySchema = Type.Object({
  id: Uuid,
  actorUserId: Type.Union([Uuid, Type.Null()]),
  /** Display name of the actor; "Unknown user" when they can no longer be read; null for system actions. */
  actorName: Type.Union([Type.Null(), Type.String()]),
  actorEmail: Type.Union([Type.Null(), Type.String()]),
  action: Type.String(),
  targetType: Type.String(),
  targetId: Type.Union([Type.String(), Type.Null()]),
  /** Entries record before/after values for changes. */
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String({ format: 'date-time' }),
});
export type AuditEntryDto = Static<typeof AuditEntrySchema>;

export const AuditListQuerySchema = Type.Object({
  action: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  /** Inclusive lower bound / exclusive upper bound on created_at. */
  from: Type.Optional(Type.String({ format: 'date-time' })),
  to: Type.Optional(Type.String({ format: 'date-time' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
});
export type AuditListQuery = Static<typeof AuditListQuerySchema>;

export const AuditListResponseSchema = Type.Object({
  items: Type.Array(AuditEntrySchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export type AuditListResponse = Static<typeof AuditListResponseSchema>;
