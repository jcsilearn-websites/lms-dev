import type {
  ConfirmImportRequest,
  ImportDto,
  ImportList,
  ImportRows,
  ImportStatus,
} from '@lms/backend/contracts';
import { api, download, upload } from '../../shared/api/client';

export type ImportKind = 'students' | 'faculty';

export const importKeys = {
  all: ['imports'] as const,
  list: ['imports', 'list'] as const,
  detail: (id: string) => ['imports', 'detail', id] as const,
  rows: (id: string, status: string) => ['imports', 'rows', id, status] as const,
};

/** The statuses after which nothing changes any more (polling stops). */
export const TERMINAL: ReadonlySet<ImportStatus> = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);
/** The server is working on it: keep polling. */
export const RUNNING: ReadonlySet<ImportStatus> = new Set(['parsing', 'queued', 'processing']);

export const getImport = (id: string, signal?: AbortSignal) =>
  api<ImportDto>(`/imports/${id}`, { signal });
export const listImports = (signal?: AbortSignal) =>
  api<ImportList>('/imports', { signal, query: { limit: 10 } });
export const getRows = (
  id: string,
  status: string,
  after: number | undefined,
  signal?: AbortSignal,
) =>
  api<ImportRows>(`/imports/${id}/rows`, {
    signal,
    query: { status: status === 'all' ? undefined : status, limit: 50, after },
  });
export const uploadCsv = (
  kind: ImportKind,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
) => {
  const form = new FormData();
  form.append('file', file, file.name);
  return upload<ImportDto>(`/imports?kind=${kind}`, form, onProgress, signal);
};
export const confirmImport = (id: string, body: ConfirmImportRequest) =>
  api<ImportDto>(`/imports/${id}/confirm`, { method: 'POST', body });
export const cancelImport = (id: string) =>
  api<ImportDto>(`/imports/${id}/cancel`, { method: 'POST' });
export const downloadTemplate = (kind: ImportKind) =>
  download(`/imports/templates/${kind}.csv`, `${kind}-template.csv`);
export const downloadErrors = (id: string) =>
  download(`/imports/${id}/errors.csv`, `import-${id}-errors.csv`);
