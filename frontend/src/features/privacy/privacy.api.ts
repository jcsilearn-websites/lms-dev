import type { DataExport, DataExportDownload, RequestDataExport } from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

// Typed with the backend contracts (step 14b, data protection).

export const privacyKeys = { exports: ['privacy', 'exports'] as const };

export const listDataExports = (signal?: AbortSignal) =>
  api<{ items: DataExport[] }>('/me/data-exports', { signal });

/** The password is asked again by the server; a wrong one is a 400 `invalid_current_password`. */
export const requestDataExport = (body: RequestDataExport) =>
  api<{ export: DataExport; alreadyInProgress: boolean }>('/me/data-exports', {
    method: 'POST',
    body,
  });

export const dataExportLink = (id: string) =>
  api<DataExportDownload>(`/me/data-exports/${id}/download`);
