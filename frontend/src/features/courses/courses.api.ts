import type {
  CopyContentResponse,
  CourseDto,
  CoursePage,
  DownloadTargetDto,
  FileDto,
  ItemDto,
  ModuleDto,
  OfferingDto,
  OfferingPage,
  OfferingSectionDto,
  OkResponse,
  OutlineDto,
  ParticipantDto,
  ParticipantPage,
  RequestUploadResponse,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

// Typed with the backend contracts. Every list is keyset "load more"; mutations return the new row and
// the screens patch the cached pages (see cache.ts), they do not refetch whole lists.

export const COURSE_PAGE = 25;

export const courseKeys = {
  courses: ['courses'] as const,
  courseList: (f: CourseFilters) => ['courses', 'list', f] as const,
  offerings: ['offerings'] as const,
  offeringList: (f: OfferingFilters) => ['offerings', 'list', f] as const,
  mine: ['offerings', 'mine'] as const,
  offering: (id: string) => ['offerings', 'detail', id] as const,
  outline: (id: string) => ['offerings', 'outline', id] as const,
  item: (id: string, itemId: string) => ['offerings', 'item', id, itemId] as const,
  sections: (id: string) => ['offerings', 'sections', id] as const,
  people: (id: string, filter: string) => ['offerings', 'people', id, filter] as const,
};

export interface CourseFilters {
  q?: string | undefined;
  /** a department id, 'none' for courses without a department */
  department?: string | undefined;
  archived?: boolean | undefined;
}
export interface OfferingFilters {
  courseId?: string | undefined;
  termId?: string | undefined;
  status?: string | undefined;
}

// ------------------------------------------------------------------ courses
export const listCourses = (f: CourseFilters, after: string | undefined, signal?: AbortSignal) =>
  api<CoursePage>('/courses', {
    signal,
    query: {
      limit: COURSE_PAGE,
      after,
      q: f.q && f.q.length >= 1 ? f.q : undefined,
      department: f.department,
      archived: f.archived ? true : undefined,
    },
  });
export const createCourse = (body: {
  code: string;
  title: string;
  description?: string | undefined;
  credits?: number | undefined;
  departmentId?: string | undefined;
}) => api<CourseDto>('/courses', { method: 'POST', body });
export const updateCourse = (id: string, body: Record<string, unknown>) =>
  api<CourseDto>(`/courses/${id}`, { method: 'PATCH', body });

// ------------------------------------------------------------------ offerings
export const listOfferings = (
  f: OfferingFilters,
  after: string | undefined,
  signal?: AbortSignal,
) => api<OfferingPage>('/offerings', { signal, query: { limit: COURSE_PAGE, after, ...f } });
export const listMyCourses = (after: string | undefined, signal?: AbortSignal) =>
  api<OfferingPage>('/me/courses', { signal, query: { limit: 50, after } });
export const getOffering = (id: string, signal?: AbortSignal) =>
  api<OfferingDto>(`/offerings/${id}`, { signal });
export const createOffering = (body: {
  courseId: string;
  termId: string;
  label?: string | undefined;
  titleOverride?: string | undefined;
}) => api<OfferingDto>('/offerings', { method: 'POST', body });
export const updateOffering = (id: string, body: Record<string, unknown>) =>
  api<OfferingDto>(`/offerings/${id}`, { method: 'PATCH', body });
export const offeringAction = (id: string, action: 'publish' | 'unpublish' | 'archive') =>
  api<OfferingDto>(`/offerings/${id}/${action}`, { method: 'POST' });

// ------------------------------------------------------------------ sections
export const listOfferingSections = (id: string, signal?: AbortSignal) =>
  api<{ items: OfferingSectionDto[] }>(`/offerings/${id}/sections`, { signal });
export const addOfferingSection = (id: string, sectionId: string) =>
  api<OkResponse>(`/offerings/${id}/sections`, { method: 'POST', body: { sectionId } });
export const removeOfferingSection = (id: string, sectionId: string) =>
  api<OkResponse>(`/offerings/${id}/sections/${sectionId}`, { method: 'DELETE' });

// ------------------------------------------------------------------ participants
export const listParticipants = (
  id: string,
  filter: { participation?: string | undefined; includeRemoved?: boolean | undefined },
  after: string | undefined,
  signal?: AbortSignal,
) =>
  api<ParticipantPage>(`/offerings/${id}/participants`, {
    signal,
    query: {
      limit: 50,
      after,
      participation: filter.participation,
      includeRemoved: filter.includeRemoved,
    },
  });
export const addParticipant = (
  id: string,
  body: { userId: string; participation: 'instructor' | 'assistant' | 'learner' },
) => api<ParticipantDto>(`/offerings/${id}/participants`, { method: 'POST', body });
export const changeParticipant = (
  id: string,
  participantId: string,
  participation: 'instructor' | 'assistant' | 'learner',
) =>
  api<ParticipantDto>(`/offerings/${id}/participants/${participantId}`, {
    method: 'PATCH',
    body: { participation },
  });
export const removeParticipant = (id: string, participantId: string) =>
  api<OkResponse>(`/offerings/${id}/participants/${participantId}`, { method: 'DELETE' });

// ------------------------------------------------------------------ content
export const getOutline = (id: string, signal?: AbortSignal) =>
  api<OutlineDto>(`/offerings/${id}/outline`, { signal });
export const getItem = (id: string, itemId: string, signal?: AbortSignal) =>
  api<ItemDto>(`/offerings/${id}/items/${itemId}`, { signal });
export const itemDownload = (id: string, itemId: string) =>
  api<DownloadTargetDto>(`/offerings/${id}/items/${itemId}/download`);

export const createModule = (id: string, body: { title: string; after?: string | null }) =>
  api<ModuleDto>(`/offerings/${id}/modules`, { method: 'POST', body });
export const updateModule = (id: string, moduleId: string, body: Record<string, unknown>) =>
  api<ModuleDto>(`/offerings/${id}/modules/${moduleId}`, { method: 'PATCH', body });
export const moveModule = (id: string, moduleId: string, after: string | null) =>
  api<ModuleDto>(`/offerings/${id}/modules/${moduleId}/move`, { method: 'POST', body: { after } });
export const deleteModule = (id: string, moduleId: string) =>
  api<OkResponse>(`/offerings/${id}/modules/${moduleId}`, { method: 'DELETE' });

export const createItem = (id: string, moduleId: string, body: Record<string, unknown>) =>
  api<ItemDto>(`/offerings/${id}/modules/${moduleId}/items`, { method: 'POST', body });
export const updateItem = (id: string, itemId: string, body: Record<string, unknown>) =>
  api<ItemDto>(`/offerings/${id}/items/${itemId}`, { method: 'PATCH', body });
export const moveItem = (
  id: string,
  itemId: string,
  body: { moduleId?: string | undefined; after: string | null },
) => api<ItemDto>(`/offerings/${id}/items/${itemId}/move`, { method: 'POST', body });
export const deleteItem = (id: string, itemId: string) =>
  api<OkResponse>(`/offerings/${id}/items/${itemId}`, { method: 'DELETE' });

export const copyContent = (id: string, sourceOfferingId: string) =>
  api<CopyContentResponse>(`/offerings/${id}/copy`, { method: 'POST', body: { sourceOfferingId } });

// ------------------------------------------------------------------ files
export const requestUpload = (id: string, name: string, size: number) =>
  api<RequestUploadResponse>(`/offerings/${id}/files`, { method: 'POST', body: { name, size } });
export const confirmUpload = (fileId: string) =>
  api<FileDto>(`/files/${fileId}/confirm`, { method: 'POST' });
