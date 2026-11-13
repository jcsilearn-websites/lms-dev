import type {
  CategoryInput,
  GradebookConfig,
  GradebookSettings,
  GradeScale,
  GradeScaleInput,
  Grid,
  ItemInput,
  LearnerExplanation,
  LearnerGrades,
  MarkImportSummary,
  MarksSaveResponse,
  Queue,
  Review,
  SettingsPatch,
} from '@lms/backend/contracts';
import { api, download } from '../../shared/api/client';

// Typed with the backend contracts (step 11). Only `import type`: this module loads with the shell.

export const GRID_CHUNK = 500;

export const gradebookKeys = {
  all: ['gradebook'] as const,
  config: (offeringId: string) => ['gradebook', offeringId, 'config'] as const,
  review: (offeringId: string) => ['gradebook', offeringId, 'review'] as const,
  grid: (offeringId: string, section: string | undefined) =>
    ['gradebook', offeringId, 'grid', section ?? ''] as const,
  learner: (offeringId: string, participantId: string) =>
    ['gradebook', offeringId, 'learner', participantId] as const,
  mine: (offeringId: string) => ['gradebook', offeringId, 'mine'] as const,
  queue: (status: string) => ['gradebook', 'queue', status] as const,
  college: ['gradebook', 'college'] as const,
  scales: ['gradebook', 'scales'] as const,
};

const base = (id: string) => `/offerings/${id}/gradebook`;

export const getConfig = (id: string, signal?: AbortSignal) =>
  api<GradebookConfig>(base(id), { signal });
export const getReview = (id: string, signal?: AbortSignal) =>
  api<Review>(`${base(id)}/review`, { signal });
export const patchSettings = (id: string, body: SettingsPatch) =>
  api<GradebookConfig>(`${base(id)}/settings`, { method: 'PATCH', body });
export const saveCategories = (id: string, categories: CategoryInput[]) =>
  api<GradebookConfig>(`${base(id)}/categories`, { method: 'PUT', body: { categories } });
export const saveItems = (id: string, items: ItemInput[]) =>
  api<GradebookConfig>(`${base(id)}/items`, { method: 'PUT', body: { items } });

export const getGrid = (
  id: string,
  section: string | undefined,
  after: string | undefined,
  signal?: AbortSignal,
) => api<Grid>(`${base(id)}/grid`, { query: { section, after, limit: GRID_CHUNK }, signal });
export const getLearner = (id: string, participantId: string, signal?: AbortSignal) =>
  api<LearnerExplanation>(`${base(id)}/learners/${participantId}`, { signal });

export interface MarkCell {
  itemId: string;
  participantId: string;
  points: string | null;
  expected?: string | null;
}
export const saveMarks = (id: string, cells: MarkCell[]) =>
  api<MarksSaveResponse>(`${base(id)}/marks`, { method: 'PUT', body: { cells } });

export const stageImport = (id: string, csv: string) =>
  api<MarkImportSummary>(`${base(id)}/mark-imports`, { method: 'POST', body: { csv } });
export const applyImport = (id: string, importId: string, skipInvalid: boolean) =>
  api<{ saved: number; unchanged: number; skippedRows: number }>(
    `${base(id)}/mark-imports/${importId}/apply`,
    { method: 'POST', body: { skipInvalid } },
  );

export const setOverride = (
  id: string,
  participantId: string,
  body: { itemId: string | null; points: string; reason: string },
) =>
  api<{ ok: boolean }>(`${base(id)}/learners/${participantId}/override`, { method: 'PUT', body });
export const revokeOverride = (id: string, participantId: string, itemId: string | null) =>
  api<{ ok: boolean }>(`${base(id)}/learners/${participantId}/override`, {
    method: 'DELETE',
    query: { itemId },
  });

type Workflow = { status: string; versionNo: number };
export const submitGradebook = (id: string) =>
  api<Workflow>(`${base(id)}/submit`, { method: 'POST' });
export const approveGradebook = (id: string, comment?: string) =>
  api<Workflow>(`${base(id)}/approve`, { method: 'POST', body: { comment } });
export const returnGradebook = (id: string, comment: string) =>
  api<Workflow>(`${base(id)}/return`, { method: 'POST', body: { comment } });
export const unlockGradebook = (id: string, reason: string) =>
  api<Workflow>(`${base(id)}/unlock`, { method: 'POST', body: { reason } });

export const exportFile = (id: string, format: 'csv' | 'xlsx', version: number) =>
  download(`${base(id)}/export.${format}?version=${version}`, `gradebook-v${version}.${format}`);

export const getMyGrades = (id: string, signal?: AbortSignal) =>
  api<LearnerGrades>(`/offerings/${id}/me/grades`, { signal });

export const getQueue = (status: string, after: string | undefined, signal?: AbortSignal) =>
  api<Queue>('/gradebook/queue', { query: { status, after, limit: 50 }, signal });
export const getCollegeSettings = (signal?: AbortSignal) =>
  api<GradebookSettings>('/gradebook/settings', { signal });
export const patchCollegeSettings = (body: GradebookSettings) =>
  api<GradebookSettings>('/gradebook/settings', { method: 'PATCH', body });

export const listScales = (includeArchived: boolean, signal?: AbortSignal) =>
  api<{ items: GradeScale[] }>('/grade-scales', { query: { includeArchived }, signal });
export const createScale = (body: GradeScaleInput) =>
  api<GradeScale>('/grade-scales', { method: 'POST', body });
export const updateScale = (id: string, body: GradeScaleInput) =>
  api<GradeScale>(`/grade-scales/${id}`, { method: 'PUT', body });
export const archiveScale = (id: string, archived: boolean) =>
  api<GradeScale>(`/grade-scales/${id}`, { method: 'PATCH', body: { archived } });
