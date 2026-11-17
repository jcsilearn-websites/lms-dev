import type {
  MyEmailStatus,
  NotificationCategory,
  NotificationPage,
  NotificationSettings,
  Preferences,
  SuppressionPage,
  UnsubscribeInfo,
  UpdateNotificationSettingsRequest,
  UpdatePreferenceRequest,
} from '@lms/backend/contracts';
import { API_BASE, api } from '../../shared/api/client';

// Typed with the backend contracts (step 13). The bell's poll is a raw fetch: it sends If-None-Match and treats 304 as "same".

export const notificationKeys = {
  unread: ['notifications', 'unread'] as const,
  latest: ['notifications', 'latest'] as const,
  list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
  prefs: ['notifications', 'preferences'] as const,
  settings: ['notifications', 'settings'] as const,
  emailStatus: ['notifications', 'email-status'] as const,
  suppressions: ['notifications', 'suppressions'] as const,
  unsubscribe: (token: string) => ['notifications', 'unsubscribe', token] as const,
};

export type UnreadPoll =
  | { kind: 'changed'; unread: number; etag: string | null }
  | { kind: 'same' }
  | { kind: 'signed-out' };

/** One poll of the bell: 200 with the count, 304 when the ETag still matches, 401 / 403 = stop polling. */
export async function pollUnread(etag: string | null, signal?: AbortSignal): Promise<UnreadPoll> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-requested-with': 'lms' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(`${API_BASE}/notifications/unread-count`, {
    credentials: 'include',
    headers,
    signal,
    cache: 'no-store',
  });
  if (res.status === 304) return { kind: 'same' };
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (!res.ok) throw new Error(`unread count: ${res.status}`);
  const body = (await res.json()) as { unread: number };
  return { kind: 'changed', unread: body.unread, etag: res.headers.get('etag') };
}

/** The member's notifications (tenant host) or the platform admin's (admin host). */
export const listNotifications = (
  platform: boolean,
  q: { after?: string | undefined; limit?: number; unread?: boolean },
  signal?: AbortSignal,
) =>
  api<NotificationPage>(platform ? '/platform/notifications' : '/notifications', {
    signal,
    query: { after: q.after, limit: q.limit ?? 20, unread: q.unread ? true : undefined },
  });

export const markRead = (id: string) =>
  api<{ updated: number }>(`/notifications/${id}/read`, { method: 'POST' });
export const markAllRead = (platform: boolean) =>
  platform
    ? api<{ updated: number }>('/platform/notifications/read', { method: 'POST', body: {} })
    : api<{ updated: number }>('/notifications/read-all', { method: 'POST' });
export const markPlatformRead = (id: string) =>
  api<{ updated: number }>('/platform/notifications/read', { method: 'POST', body: { id } });

export const getPreferences = (signal?: AbortSignal) =>
  api<Preferences>('/me/notification-preferences', { signal });
export const updatePreference = (body: UpdatePreferenceRequest) =>
  api<Preferences>('/me/notification-preferences', { method: 'PUT', body });

export const getNotificationSettings = (signal?: AbortSignal) =>
  api<NotificationSettings>('/notifications/settings', { signal });
export const updateNotificationSettings = (body: UpdateNotificationSettingsRequest) =>
  api<NotificationSettings>('/notifications/settings', { method: 'PATCH', body });

export const getEmailStatus = (signal?: AbortSignal) =>
  api<MyEmailStatus>('/me/email-status', { signal });
export const listSuppressions = (after: string | undefined, signal?: AbortSignal) =>
  api<SuppressionPage>('/email/suppressions', { signal, query: { after, limit: 50 } });
export const clearSuppression = (id: string) =>
  api<void>(`/email/suppressions/${id}`, { method: 'DELETE' });

export const getUnsubscribeInfo = (token: string, signal?: AbortSignal) =>
  api<UnsubscribeInfo>('/notifications/unsubscribe', {
    signal,
    query: { t: token },
    anonymousOk: true,
  });
export const unsubscribe = (token: string) =>
  api<{ unsubscribed: true; categoryLabel: string }>('/notifications/unsubscribe', {
    method: 'POST',
    body: { token },
    anonymousOk: true,
  });

/** Words of the preference page (the same as the email footers). */
export const CATEGORY_TEXT: Record<NotificationCategory, { label: string; description: string }> = {
  security: {
    label: 'Account and security',
    description: 'Invitations, password resets and password changes. Always on.',
  },
  learning_deadlines: {
    label: 'Deadlines and reminders',
    description:
      'Due dates 24 hours and 1 hour ahead, quizzes opening and closing, deadline changes.',
  },
  learning_grades: {
    label: 'Grades and results',
    description: 'When your graded work or a quiz result is ready to see.',
  },
  learning_content: {
    label: 'New course content',
    description: 'One summary per course per day when new material is published.',
  },
  teaching_grading: {
    label: 'Grading and gradebooks',
    description: 'A daily summary of work waiting to be graded; gradebooks returned or approved.',
  },
  teaching_updates: {
    label: 'Teaching updates',
    description: 'Videos processed, and a weekly count of learners who may need help.',
  },
  admin: {
    label: 'Administration',
    description: 'Gradebooks waiting for approval, finished imports, weekly course health.',
  },
};
