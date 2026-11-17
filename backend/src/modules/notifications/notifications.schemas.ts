import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  ErrorResponseSchema,
  ListNotificationsQuerySchema,
  MarkedSchema,
  NotificationPageSchema,
  NotificationSettingsSchema,
  PreferencesSchema,
  UnreadCountSchema,
  UnsubscribeInfoSchema,
  UnsubscribeRequestSchema,
  UnsubscribeResultSchema,
  UnsubscribeTokenQuerySchema,
  UpdateNotificationSettingsRequestSchema,
  UpdatePreferenceRequestSchema,
} from '../../contracts';

const tags = ['notifications'];
export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const ListQuery = ListNotificationsQuerySchema;
export const PlatformReadBody = Type.Object(
  { id: Type.Optional(Type.String({ format: 'uuid' })) },
  { additionalProperties: false },
);

export const listRouteSchema = {
  tags,
  summary: "The signed-in member's notifications, newest first (keyset)",
  querystring: ListQuery,
  response: { 200: NotificationPageSchema, ...COMMON_ERRORS },
};
export const unreadRouteSchema = {
  tags,
  summary:
    'The bell: unread count (capped at 100). Send If-None-Match with the last ETag: 304 when nothing changed',
  response: { 200: UnreadCountSchema, 304: Type.Null(), ...COMMON_ERRORS },
};
export const markReadRouteSchema = {
  tags,
  summary: 'Mark one notification read',
  params: IdParams,
  response: { 200: MarkedSchema, ...COMMON_ERRORS },
};
export const markAllReadRouteSchema = {
  tags,
  summary: 'Mark every notification read',
  response: { 200: MarkedSchema, ...COMMON_ERRORS },
};
export const preferencesRouteSchema = {
  tags,
  summary: 'My notification preferences per category and channel (security is mandatory)',
  response: { 200: PreferencesSchema, ...COMMON_ERRORS },
};
export const updatePreferenceRouteSchema = {
  tags,
  summary: 'Change one category (effective immediately). Security cannot be switched off (409)',
  body: UpdatePreferenceRequestSchema,
  response: { 200: PreferencesSchema, ...COMMON_ERRORS },
};
export const settingsRouteSchema = {
  tags,
  summary: "The college's notification defaults, quiet hours, digest hour and sender name",
  response: { 200: NotificationSettingsSchema, ...COMMON_ERRORS },
};
export const updateSettingsRouteSchema = {
  tags,
  summary: "Change the college's notification settings (audited with before and after)",
  body: UpdateNotificationSettingsRequestSchema,
  response: { 200: NotificationSettingsSchema, ...COMMON_ERRORS },
};
export const unsubscribeInfoRouteSchema = {
  tags,
  summary: 'What an unsubscribe link would switch off (public; the signed token is the authority)',
  querystring: UnsubscribeTokenQuerySchema,
  response: { 200: UnsubscribeInfoSchema, ...COMMON_ERRORS },
};
export const unsubscribeRouteSchema = {
  tags,
  summary: 'Unsubscribe from one category of email (public, from the unsubscribe page)',
  body: UnsubscribeRequestSchema,
  response: { 200: UnsubscribeResultSchema, ...COMMON_ERRORS },
};
export const oneClickRouteSchema = {
  tags,
  summary:
    'RFC 8058 one-click unsubscribe (the List-Unsubscribe-Post target; mail clients POST it without Origin or our CSRF header)',
  querystring: UnsubscribeTokenQuerySchema,
  response: { 200: UnsubscribeResultSchema, 415: ErrorResponseSchema, ...COMMON_ERRORS },
};
export const platformListRouteSchema = {
  tags: ['platform'],
  summary: "The platform admin's notifications (admin host)",
  querystring: ListQuery,
  response: { 200: NotificationPageSchema, ...COMMON_ERRORS },
};
export const platformReadRouteSchema = {
  tags: ['platform'],
  summary: 'Mark one (id) or every platform notification read',
  body: PlatformReadBody,
  response: { 200: MarkedSchema, ...COMMON_ERRORS },
};
