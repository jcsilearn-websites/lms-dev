import type {
  ActiveUsers,
  AnalyticsSettings,
  AtRiskPage,
  LearnerDashboard,
  OfferingDashboard,
  ReportTable,
  ReportTableId,
  TeachingDashboard,
  UpdateAnalyticsSettingsRequest,
  UsageResponse,
  VideoEngagement,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

// Typed with the backend contracts (step 12). Every dashboard is one read; the API says "data as of" and the college time zone.

export const analyticsKeys = {
  learner: ['analytics', 'learner'] as const,
  teaching: ['analytics', 'teaching'] as const,
  offering: (id: string) => ['analytics', 'offering', id] as const,
  video: (id: string, itemId: string) => ['analytics', 'video', id, itemId] as const,
  atRisk: (id: string) => ['analytics', 'at-risk', id] as const,
  settings: ['analytics', 'settings'] as const,
  activeUsers: ['analytics', 'active-users'] as const,
  report: (table: ReportTableId, scope?: string, days?: number) =>
    ['analytics', 'report', table, scope ?? '', days ?? 0] as const,
  usage: (month: string) => ['analytics', 'usage', month] as const,
};

export const getLearnerDashboard = (signal?: AbortSignal) =>
  api<LearnerDashboard>('/me/dashboard', { signal });
export const getTeachingDashboard = (signal?: AbortSignal) =>
  api<TeachingDashboard>('/me/teaching/dashboard', { signal });
export const getOfferingDashboard = (id: string, signal?: AbortSignal) =>
  api<OfferingDashboard>(`/offerings/${id}/dashboard`, { signal });
export const getVideoEngagement = (id: string, itemId: string, signal?: AbortSignal) =>
  api<VideoEngagement>(`/offerings/${id}/videos/${itemId}/engagement`, { signal });

export const AT_RISK_PAGE = 25;
export const listAtRisk = (id: string, after: string | undefined, signal?: AbortSignal) =>
  api<AtRiskPage>(`/offerings/${id}/at-risk`, { query: { limit: AT_RISK_PAGE, after }, signal });
export const atRiskExportPath = (id: string, format: 'csv' | 'xlsx') =>
  `/offerings/${id}/at-risk.${format}`;

export const getAnalyticsSettings = (signal?: AbortSignal) =>
  api<AnalyticsSettings>('/analytics/settings', { signal });
export const updateAnalyticsSettings = (body: UpdateAnalyticsSettingsRequest) =>
  api<AnalyticsSettings>('/analytics/settings', { method: 'PATCH', body });

export const getActiveUsers = (signal?: AbortSignal) =>
  api<ActiveUsers>('/reports/active-users', { signal });
export const getReport = (
  table: ReportTableId,
  opts: { scope?: string | undefined; days?: number | undefined } = {},
  signal?: AbortSignal,
) =>
  api<ReportTable>(`/reports/${table}`, { query: { scope: opts.scope, days: opts.days }, signal });
export const reportExportPath = (
  table: ReportTableId,
  format: 'csv' | 'xlsx',
  opts: { scope?: string | undefined; days?: number | undefined } = {},
) => {
  const q = new URLSearchParams({ format });
  if (opts.scope) q.set('scope', opts.scope);
  if (opts.days) q.set('days', String(opts.days));
  return `/reports/${table}/export?${q.toString()}`;
};

export const getUsage = (month: string | undefined, signal?: AbortSignal) =>
  api<UsageResponse>('/platform/usage', { query: { month }, signal });
export const usageExportPath = (month: string, format: 'csv' | 'xlsx') =>
  `/platform/usage/export?format=${format}&month=${month}`;

/** An instant in the COLLEGE's time zone ("4 Nov 2026, 15:30"), never the browser's. */
export function formatCollegeTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
export function formatCollegeDay(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(d);
}
