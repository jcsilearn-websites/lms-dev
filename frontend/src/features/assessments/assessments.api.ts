import type {
  AccommodationInputSchema,
  AnalysisDto,
  AssessmentConfig,
  AssessmentMe,
  AssessmentSettings,
  AttemptDto,
  DownloadTargetDto,
  FileDto,
  QuestionDto,
  QuestionImportDto,
  QuestionInput,
  QuestionPage,
  RegradeResponse,
  RequestUploadResponse,
  ResultDto,
  SaveRequest,
  SaveResponse,
} from '@lms/backend/contracts';
import type { Static } from '@sinclair/typebox';
import { api, download } from '../../shared/api/client';

// Typed with the backend contracts (type-only imports: no backend code lands in the browser bundle).

export const QUESTION_PAGE = 25;

export const assessmentKeys = {
  questions: (courseId: string) => ['questions', courseId] as const,
  questionList: (courseId: string, f: QuestionFilters) =>
    ['questions', courseId, 'list', f] as const,
  question: (courseId: string, id: string, version?: number) =>
    ['questions', courseId, 'one', id, version ?? 'current'] as const,
  versions: (courseId: string, id: string) => ['questions', courseId, 'versions', id] as const,
  tags: (courseId: string) => ['questions', courseId, 'tags'] as const,
  config: (offeringId: string, itemId: string) =>
    ['assessment', offeringId, itemId, 'config'] as const,
  me: (offeringId: string, itemId: string) => ['assessment', offeringId, itemId, 'me'] as const,
  attempt: (offeringId: string, attemptId: string) => ['attempt', offeringId, attemptId] as const,
  result: (offeringId: string, attemptId: string) =>
    ['attempt', offeringId, attemptId, 'result'] as const,
  attempts: (offeringId: string, itemId: string, status: string) =>
    ['assessment', offeringId, itemId, 'attempts', status] as const,
  grading: (offeringId: string, itemId: string) =>
    ['assessment', offeringId, itemId, 'grading'] as const,
  answers: (offeringId: string, itemId: string, questionId: string, state: string) =>
    ['assessment', offeringId, itemId, 'answers', questionId, state] as const,
  script: (offeringId: string, attemptId: string) =>
    ['attempt', offeringId, attemptId, 'script'] as const,
  accommodations: (offeringId: string, itemId: string) =>
    ['assessment', offeringId, itemId, 'accommodations'] as const,
  analysis: (offeringId: string, itemId: string) =>
    ['assessment', offeringId, itemId, 'analysis'] as const,
  regrades: (offeringId: string, itemId: string) =>
    ['assessment', offeringId, itemId, 'regrades'] as const,
};

export interface QuestionFilters {
  type?: string | undefined;
  difficulty?: string | undefined;
  tag?: string | undefined;
  archived?: boolean | undefined;
}

// ------------------------------------------------------------------ question bank (course scope)
export const listQuestions = (
  courseId: string,
  f: QuestionFilters,
  after: string | undefined,
  signal?: AbortSignal,
) =>
  api<QuestionPage>(`/courses/${courseId}/questions`, {
    signal,
    query: {
      limit: QUESTION_PAGE,
      after,
      type: f.type,
      difficulty: f.difficulty,
      tag: f.tag,
      status: f.archived ? 'archived' : undefined,
    },
  });
export const getQuestion = (courseId: string, id: string, version?: number, signal?: AbortSignal) =>
  api<QuestionDto>(`/courses/${courseId}/questions/${id}`, { signal, query: { version } });
export const listVersions = (courseId: string, id: string, signal?: AbortSignal) =>
  api<{
    items: {
      version: number;
      versionId: string;
      current: boolean;
      createdAt: string;
      createdByName: string | null;
    }[];
  }>(`/courses/${courseId}/questions/${id}/versions`, { signal });
export const listTags = (courseId: string, signal?: AbortSignal) =>
  api<{ items: { tag: string; count: number }[] }>(`/courses/${courseId}/question-tags`, {
    signal,
  });
export const createQuestion = (courseId: string, body: QuestionInput) =>
  api<QuestionDto>(`/courses/${courseId}/questions`, { method: 'POST', body });
export const updateQuestion = (courseId: string, id: string, body: QuestionInput) =>
  api<QuestionDto>(`/courses/${courseId}/questions/${id}`, { method: 'PUT', body });
export const setQuestionArchived = (courseId: string, id: string, archived: boolean) =>
  api<QuestionDto>(`/courses/${courseId}/questions/${id}/${archived ? 'archive' : 'unarchive'}`, {
    method: 'POST',
  });
export const questionImage = (courseId: string, id: string, fileId: string) =>
  api<DownloadTargetDto>(`/courses/${courseId}/questions/${id}/files/${fileId}`);

export const requestCourseUpload = (courseId: string, name: string, size: number) =>
  api<RequestUploadResponse>(`/courses/${courseId}/files`, {
    method: 'POST',
    body: { name, size },
  });
export const confirmUpload = (fileId: string) =>
  api<FileDto>(`/files/${fileId}/confirm`, { method: 'POST' });

export const downloadQuestionTemplate = (courseId: string) =>
  download(`/courses/${courseId}/question-imports/template.csv`, 'questions-template.csv');
export const uploadQuestionImport = (courseId: string, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return api<QuestionImportDto>(`/courses/${courseId}/question-imports`, {
    method: 'POST',
    body: form,
  });
};
export const importRows = (
  courseId: string,
  importId: string,
  status: 'invalid' | 'valid' | undefined,
) =>
  api<{
    items: {
      rowNo: number;
      valid: boolean;
      errors: { column: string; message: string }[];
      question: string;
      type: string;
    }[];
    nextCursor: number | null;
  }>(`/courses/${courseId}/question-imports/${importId}/rows`, { query: { status, limit: 200 } });
export const confirmImport = (courseId: string, importId: string, skipInvalid: boolean) =>
  api<QuestionImportDto>(`/courses/${courseId}/question-imports/${importId}/confirm`, {
    method: 'POST',
    body: { skipInvalid },
  });
export const cancelImport = (courseId: string, importId: string) =>
  api<QuestionImportDto>(`/courses/${courseId}/question-imports/${importId}/cancel`, {
    method: 'POST',
  });

// ------------------------------------------------------------------ the builder
const A = (offeringId: string, itemId: string) =>
  `/offerings/${offeringId}/items/${itemId}/assessment`;

export const getConfig = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<AssessmentConfig>(A(offeringId, itemId), { signal });
export const updateSettings = (
  offeringId: string,
  itemId: string,
  body: Partial<AssessmentSettings>,
) => api<AssessmentSettings>(A(offeringId, itemId), { method: 'PUT', body });
export interface SlotInput {
  kind: 'fixed' | 'pool';
  questionId?: string | undefined;
  tag?: string | undefined;
  difficulty?: 'easy' | 'medium' | 'hard' | undefined;
  count?: number | undefined;
  points: number;
}
export const replaceSlots = (offeringId: string, itemId: string, slots: SlotInput[]) =>
  api<{ slots: number }>(`${A(offeringId, itemId)}/slots`, { method: 'PUT', body: { slots } });
export const previewPaper = (offeringId: string, itemId: string) =>
  api<{ questions: AttemptDto['questions'] }>(`${A(offeringId, itemId)}/preview`);

export interface AccommodationRow {
  participantId: string;
  learnerName: string;
  learnerEmail: string;
  extraMinutes: number;
  extendedCloseAt: string | null;
  reason: string | null;
  updatedAt: string;
}
export const listAccommodations = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<{ items: AccommodationRow[] }>(`${A(offeringId, itemId)}/accommodations`, { signal });
export const putAccommodation = (
  offeringId: string,
  itemId: string,
  participantId: string,
  body: Static<typeof AccommodationInputSchema>,
) =>
  api<AccommodationRow>(`${A(offeringId, itemId)}/accommodations/${participantId}`, {
    method: 'PUT',
    body,
  });
export const deleteAccommodation = (offeringId: string, itemId: string, participantId: string) =>
  api<{ status: string }>(`${A(offeringId, itemId)}/accommodations/${participantId}`, {
    method: 'DELETE',
  });

// ------------------------------------------------------------------ the learner
export const getMe = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<AssessmentMe>(`${A(offeringId, itemId)}/me`, { signal });
export const startAttempt = (offeringId: string, itemId: string) =>
  api<{ attemptId: string; resumed: boolean }>(
    `/offerings/${offeringId}/items/${itemId}/attempts`,
    {
      method: 'POST',
      body: {},
    },
  );
export const readAttempt = (offeringId: string, attemptId: string, signal?: AbortSignal) =>
  api<AttemptDto>(`/offerings/${offeringId}/attempts/${attemptId}`, { signal });
export const saveAnswers = (
  offeringId: string,
  attemptId: string,
  body: SaveRequest,
  o: { keepalive?: boolean; signal?: AbortSignal } = {},
) =>
  api<SaveResponse>(`/offerings/${offeringId}/attempts/${attemptId}/answers`, {
    method: 'PUT',
    body,
    ...(o.keepalive ? { keepalive: true } : {}),
    signal: o.signal,
  });
export const submitAttempt = (offeringId: string, attemptId: string) =>
  api<{ status: 'submitted' | 'graded'; submittedAt: string }>(
    `/offerings/${offeringId}/attempts/${attemptId}/submit`,
    { method: 'POST', body: {} },
  );
export const getResult = (offeringId: string, attemptId: string, signal?: AbortSignal) =>
  api<ResultDto>(`/offerings/${offeringId}/attempts/${attemptId}/result`, { signal });
export const attemptImage = (offeringId: string, attemptId: string, fileId: string) =>
  api<DownloadTargetDto>(`/offerings/${offeringId}/attempts/${attemptId}/files/${fileId}`);

// ------------------------------------------------------------------ grading, regrade, release, analysis
export interface AttemptRow {
  attemptId: string;
  participantId: string;
  learnerName: string;
  learnerEmail: string;
  attemptNo: number;
  status: 'in_progress' | 'submitted' | 'graded';
  startedAt: string;
  submittedAt: string | null;
  submitKind: 'manual' | 'deadline' | null;
  score: number | null;
  maxScore: number | null;
  pendingManual: number;
  eventCount: number;
  released: boolean;
}
export const listAttempts = (
  offeringId: string,
  itemId: string,
  status: string | undefined,
  after: string | undefined,
  signal?: AbortSignal,
) =>
  api<{ items: AttemptRow[]; nextCursor: string | null }>(`${A(offeringId, itemId)}/attempts`, {
    signal,
    query: { status, after, limit: 50 },
  });
export interface GradingSummary {
  questions: {
    questionId: string;
    type: string;
    stem: unknown;
    points: number;
    pending: number;
    graded: number;
  }[];
  attemptsToGrade: number;
}
export const gradingSummary = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<GradingSummary>(`${A(offeringId, itemId)}/grading/summary`, { signal });
export interface GradingAnswer {
  attemptId: string;
  position: number;
  learnerName: string;
  answer: { o?: string[]; n?: number; t?: string } | null;
  points: number;
  score: number | null;
  feedback: string | null;
  state: 'pending' | 'graded';
}
export interface GradingAnswers {
  question: {
    questionId: string;
    type: string;
    stem: unknown;
    key: Record<string, unknown>;
    maxWords: number | null;
  };
  items: GradingAnswer[];
  nextCursor: string | null;
}
export const gradingAnswers = (
  offeringId: string,
  itemId: string,
  q: { questionId: string; state: 'pending' | 'graded' | 'all' },
  after: string | undefined,
  signal?: AbortSignal,
) =>
  api<GradingAnswers>(`${A(offeringId, itemId)}/grading/answers`, {
    signal,
    query: { questionId: q.questionId, state: q.state, after, limit: 25 },
  });
export interface Script {
  attempt: AttemptRow;
  feedback: string | null;
  events: { kind: string; at: string }[];
  questions: {
    position: number;
    questionId: string;
    type: string;
    points: number;
    dropped: boolean;
    stem: unknown;
    options: { id: string; text: unknown }[];
    images: { fileId: string; alt: string }[];
    answer: { o?: string[]; n?: number; t?: string } | null;
    key: Record<string, unknown>;
    score: number | null;
    state: 'na' | 'pending' | 'graded';
    feedback: string | null;
    spentSeconds: number;
  }[];
}
export const getScript = (offeringId: string, attemptId: string, signal?: AbortSignal) =>
  api<Script>(`/offerings/${offeringId}/attempts/${attemptId}/grading`, { signal });
export const gradeAnswer = (
  offeringId: string,
  attemptId: string,
  position: number,
  body: { score: number; feedback: string | null },
) =>
  api<{
    attemptId: string;
    position: number;
    score: number;
    attemptStatus: 'submitted' | 'graded';
    attemptScore: number | null;
    pendingManual: number;
  }>(`/offerings/${offeringId}/attempts/${attemptId}/questions/${position}/grade`, {
    method: 'PUT',
    body,
  });
export const setAttemptFeedback = (
  offeringId: string,
  attemptId: string,
  feedback: string | null,
) =>
  api<{ status: string }>(`/offerings/${offeringId}/attempts/${attemptId}/feedback`, {
    method: 'PUT',
    body: { feedback },
  });
export const regrade = (
  offeringId: string,
  itemId: string,
  body: {
    questionId: string;
    action: 'rekey' | 'drop' | 'credit';
    toVersionId?: string;
    dryRun: boolean;
  },
) => api<RegradeResponse>(`${A(offeringId, itemId)}/regrade`, { method: 'POST', body });
export const listRegrades = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<{
    items: {
      id: string;
      questionId: string;
      action: string;
      affectedAttempts: number;
      createdAt: string;
      createdByName: string | null;
    }[];
  }>(`${A(offeringId, itemId)}/regrades`, { signal });
export const releaseResults = (offeringId: string, itemId: string, attemptIds?: string[]) =>
  api<{ released: number; stillPending: number }>(`${A(offeringId, itemId)}/release`, {
    method: 'POST',
    body: attemptIds ? { attemptIds } : {},
  });
export const getAnalysis = (offeringId: string, itemId: string, signal?: AbortSignal) =>
  api<AnalysisDto>(`${A(offeringId, itemId)}/analysis`, { signal });
