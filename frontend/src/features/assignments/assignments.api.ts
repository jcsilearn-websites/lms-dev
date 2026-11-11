import type {
  AssignmentConfig,
  AssignmentFile,
  AssignmentGradingSummary,
  AssignmentMe,
  AssignmentSettings,
  CopyPreview,
  DownloadTargetDto,
  Extension,
  GradeInput,
  GradeSaved,
  GradingLearner,
  GradingQueue,
  RubricDetail,
  RubricInput,
  RubricList,
  SubmitAssignmentRequest,
  SubmitAssignmentResponse,
} from '@lms/backend/contracts';
import { API_BASE, ApiError, api } from '../../shared/api/client';

// Typed with the backend contracts (type-only imports: no backend code lands in the browser bundle).

export const QUEUE_PAGE = 50;

export const assignmentKeys = {
  config: (offeringId: string, itemId: string) =>
    ['assignment', offeringId, itemId, 'config'] as const,
  me: (offeringId: string, itemId: string) => ['assignment', offeringId, itemId, 'me'] as const,
  extensions: (offeringId: string, itemId: string) =>
    ['assignment', offeringId, itemId, 'extensions'] as const,
  queue: (offeringId: string, itemId: string, filter: string) =>
    ['assignment', offeringId, itemId, 'queue', filter] as const,
  queueAll: (offeringId: string, itemId: string) =>
    ['assignment', offeringId, itemId, 'queue'] as const,
  summary: (offeringId: string, itemId: string) =>
    ['assignment', offeringId, itemId, 'summary'] as const,
  learner: (offeringId: string, itemId: string, key: string) =>
    ['assignment', offeringId, itemId, 'learner', key] as const,
  rubrics: (courseId: string) => ['rubrics', courseId] as const,
  rubric: (courseId: string, id: string) => ['rubrics', courseId, 'one', id] as const,
  copyPreview: (targetId: string, sourceId: string) =>
    ['copy-preview', targetId, sourceId] as const,
};

const A = (offeringId: string, itemId: string) =>
  `/offerings/${offeringId}/items/${itemId}/assignment`;

// ------------------------------------------------------------------ the builder
export const getConfig = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<AssignmentConfig>(A(offeringId, itemId), { signal });
export const updateSettings = (
  offeringId: string,
  itemId: string,
  body: Partial<AssignmentSettings>,
) => api<AssignmentSettings>(A(offeringId, itemId), { method: 'PUT', body });
export const replaceAttachments = (offeringId: string, itemId: string, fileIds: string[]) =>
  api<{ attachments: AssignmentFile[] }>(`${A(offeringId, itemId)}/attachments`, {
    method: 'PUT',
    body: { fileIds },
  });
export const attachRubric = (offeringId: string, itemId: string, rubricId: string | null) =>
  api<{ status: string }>(`${A(offeringId, itemId)}/rubric`, { method: 'PUT', body: { rubricId } });

export const listExtensions = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<{ items: Extension[] }>(`${A(offeringId, itemId)}/extensions`, { signal });
export const setExtension = (
  offeringId: string,
  itemId: string,
  participantId: string,
  body: { extendedDueAt: string; reason?: string },
) =>
  api<Extension>(`${A(offeringId, itemId)}/extensions/${participantId}`, { method: 'PUT', body });
export const removeExtension = (offeringId: string, itemId: string, participantId: string) =>
  api<{ status: string }>(`${A(offeringId, itemId)}/extensions/${participantId}`, {
    method: 'DELETE',
  });

// ------------------------------------------------------------------ the learner
export const getMe = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<AssignmentMe>(`${A(offeringId, itemId)}/me`, { signal });
export const requestUpload = (offeringId: string, itemId: string, name: string, size: number) =>
  api<{
    fileId: string;
    upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
    maxBytes: number;
  }>(`${A(offeringId, itemId)}/files`, { method: 'POST', body: { name, size } });
export const confirmUpload = (offeringId: string, itemId: string, fileId: string) =>
  api<AssignmentFile>(`${A(offeringId, itemId)}/files/${fileId}/confirm`, { method: 'POST' });
export const submit = (offeringId: string, itemId: string, body: SubmitAssignmentRequest) =>
  api<SubmitAssignmentResponse>(`${A(offeringId, itemId)}/submissions`, { method: 'POST', body });
export const learnerFile = (offeringId: string, itemId: string, fileId: string) =>
  api<DownloadTargetDto>(`${A(offeringId, itemId)}/files/${fileId}`);

// ------------------------------------------------------------------ grading
export interface QueueFilter {
  status?: string | undefined;
  sectionId?: string | undefined;
  sort?: 'time' | 'code' | 'name' | undefined;
}
export const getQueue = (
  offeringId: string,
  itemId: string,
  f: QueueFilter,
  after: string | undefined,
  signal?: AbortSignal,
) =>
  api<GradingQueue>(`${A(offeringId, itemId)}/grading/queue`, {
    signal,
    query: { limit: QUEUE_PAGE, after, status: f.status, sectionId: f.sectionId, sort: f.sort },
  });
export const getSummary = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<AssignmentGradingSummary>(`${A(offeringId, itemId)}/grading/summary`, { signal });
export const getLearner = (offeringId: string, itemId: string, key: string, signal?: AbortSignal) =>
  api<GradingLearner>(`${A(offeringId, itemId)}/grading/learners/${key}`, { signal });
export const saveGrade = (offeringId: string, itemId: string, key: string, body: GradeInput) =>
  api<GradeSaved>(`${A(offeringId, itemId)}/grading/learners/${key}/grade`, {
    method: 'PUT',
    body,
  });
export const waivePenalty = (offeringId: string, itemId: string, key: string, reason: string) =>
  api<{ status: string }>(`${A(offeringId, itemId)}/grading/learners/${key}/penalty-waiver`, {
    method: 'PUT',
    body: { reason },
  });
export const restorePenalty = (offeringId: string, itemId: string, key: string) =>
  api<{ status: string }>(`${A(offeringId, itemId)}/grading/learners/${key}/penalty-waiver`, {
    method: 'DELETE',
  });
export const releaseGrades = (offeringId: string, itemId: string, learnerKeys?: string[]) =>
  api<{ released: number }>(`${A(offeringId, itemId)}/release`, {
    method: 'POST',
    body: learnerKeys ? { learnerKeys } : {},
  });
export const staffFile = (offeringId: string, itemId: string, fileId: string) =>
  api<DownloadTargetDto>(`${A(offeringId, itemId)}/grading/files/${fileId}`);
/** The ZIP is an ordinary link: the browser streams it to disk (the cookie authorises the GET). */
export const zipUrl = (offeringId: string, itemId: string) =>
  `${API_BASE}${A(offeringId, itemId)}/submissions.zip`;

// ------------------------------------------------------------------ rubrics (course scope)
export const listRubrics = (courseId: string, includeArchived: boolean, signal?: AbortSignal) =>
  api<RubricList>(`/courses/${courseId}/rubrics`, {
    signal,
    query: { limit: 100, includeArchived: includeArchived || undefined },
  });
export const getRubric = (courseId: string, id: string, signal?: AbortSignal) =>
  api<RubricDetail>(`/courses/${courseId}/rubrics/${id}`, { signal });
export const createRubric = (courseId: string, body: RubricInput) =>
  api<RubricDetail>(`/courses/${courseId}/rubrics`, { method: 'POST', body });
export const updateRubric = (courseId: string, id: string, body: RubricInput) =>
  api<RubricDetail>(`/courses/${courseId}/rubrics/${id}`, { method: 'PUT', body });
export const setRubricArchived = (courseId: string, id: string, archived: boolean) =>
  api<RubricDetail>(`/courses/${courseId}/rubrics/${id}`, { method: 'PATCH', body: { archived } });

// ------------------------------------------------------------------ copy
export const getCopyPreview = (targetId: string, sourceId: string, signal?: AbortSignal) =>
  api<CopyPreview>(`/offerings/${targetId}/copy-preview`, {
    signal,
    query: { sourceOfferingId: sourceId },
  });

// ------------------------------------------------------------------ the upload of hand-in files
/**
 * Uploads ONE hand-in file: asks for a signed URL, PUTs the bytes straight to it (XMLHttpRequest, for the progress), then
 * asks the server to confirm (it reads the bytes, checks size and type against the content). `onProgress` gets 0..1.
 */
export async function uploadHandInFile(
  offeringId: string,
  itemId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AssignmentFile> {
  const req = await requestUpload(offeringId, itemId, file.name, file.size);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', req.upload.url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-requested-with', 'lms');
    for (const [k, v] of Object.entries(req.upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let code = 'upload_failed';
      let message = 'The upload failed.';
      try {
        const body = JSON.parse(xhr.responseText) as {
          error?: { code?: string; message?: string };
        };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // not JSON: keep the generic message
      }
      reject(new ApiError(xhr.status, code, message));
    };
    xhr.onerror = () =>
      reject(
        new ApiError(0, 'network_error', 'The upload was interrupted. Check your connection.'),
      );
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
  onProgress(1);
  return confirmUpload(offeringId, itemId, req.fileId);
}
