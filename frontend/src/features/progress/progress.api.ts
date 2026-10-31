import type {
  ClassPage,
  HeartbeatRequest,
  HeartbeatResponse,
  LearnerDrilldown,
  MarkResponse,
  MyOfferingsProgress,
  MyProgress,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

// Typed with the backend contracts (step 8). The class table is keyset "load more" like every list.

export const CLASS_PAGE = 25;

export const progressKeys = {
  all: ['progress'] as const,
  /** the signed-in learner's progress in every course (My courses) */
  me: ['progress', 'me'] as const,
  /** the signed-in learner's progress in one course */
  offering: (id: string) => ['progress', 'offering', id] as const,
  classTable: (id: string, f: ClassFilters) => ['progress', 'class', id, f] as const,
  learner: (id: string, participantId: string) =>
    ['progress', 'learner', id, participantId] as const,
};

export interface ClassFilters {
  section?: string | undefined;
  status?: 'not_started' | 'in_progress' | 'behind' | 'completed' | undefined;
  learners?: 'active' | 'removed' | undefined;
  sort?: 'name' | 'percent' | 'activity' | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

const itemPath = (offeringId: string, itemId: string) =>
  `/offerings/${offeringId}/items/${itemId}/progress`;

// ------------------------------------------------------------------ the learner
export const getMyProgress = (offeringId: string, signal?: AbortSignal) =>
  api<MyProgress>(`/offerings/${offeringId}/progress`, { signal });
export const getMyOfferingsProgress = (signal?: AbortSignal) =>
  api<MyOfferingsProgress>('/me/progress', { signal });

export const sendHeartbeat = (
  offeringId: string,
  itemId: string,
  body: HeartbeatRequest,
  opts: { keepalive?: boolean; signal?: AbortSignal } = {},
) =>
  api<HeartbeatResponse>(`${itemPath(offeringId, itemId)}/heartbeat`, {
    method: 'POST',
    body,
    ...(opts.keepalive ? { keepalive: true } : {}),
    signal: opts.signal,
  });
export const markViewed = (offeringId: string, itemId: string) =>
  api<MarkResponse>(`${itemPath(offeringId, itemId)}/viewed`, { method: 'POST' });
export const markComplete = (offeringId: string, itemId: string) =>
  api<MarkResponse>(`${itemPath(offeringId, itemId)}/complete`, { method: 'POST' });
export const markIncomplete = (offeringId: string, itemId: string) =>
  api<MarkResponse>(`${itemPath(offeringId, itemId)}/complete`, { method: 'DELETE' });

// ------------------------------------------------------------------ the class view
export const listClass = (
  offeringId: string,
  f: ClassFilters,
  after: string | undefined,
  signal?: AbortSignal,
) =>
  api<ClassPage>(`/offerings/${offeringId}/progress/class`, {
    signal,
    query: {
      limit: CLASS_PAGE,
      after,
      section: f.section,
      status: f.status,
      learners: f.learners,
      sort: f.sort,
      dir: f.dir,
    },
  });
export const classCsvPath = (offeringId: string, f: ClassFilters) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, String(v));
  const s = q.toString();
  return `/offerings/${offeringId}/progress/class.csv${s ? `?${s}` : ''}`;
};
export const getLearner = (offeringId: string, participantId: string, signal?: AbortSignal) =>
  api<LearnerDrilldown>(`/offerings/${offeringId}/progress/learners/${participantId}`, { signal });
