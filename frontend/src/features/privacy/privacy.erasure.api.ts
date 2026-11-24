import type { ErasurePreview, ErasureRequest, RequestErasure } from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

// Typed with the backend contracts (step 14b-1, erasure inside a college).

export type ErasureAdminItem = ErasureRequest & { memberName: string; memberEmail: string };

export const erasureKeys = {
  preview: ['privacy', 'erasure', 'preview'] as const,
  admin: ['privacy', 'erasure', 'admin'] as const,
};

export const getErasurePreview = (signal?: AbortSignal) =>
  api<ErasurePreview>('/me/erasure/preview', { signal });

/** The password is asked again by the server; a wrong one is a 400 `invalid_current_password`. */
export const requestErasure = (body: RequestErasure) =>
  api<{ request: ErasureRequest; alreadyInProgress: boolean }>('/me/erasure', {
    method: 'POST',
    body,
  });

export const cancelMyErasure = () =>
  api<{ request: ErasureRequest }>('/me/erasure/cancel', { method: 'POST', body: {} });

export const listErasureRequests = (signal?: AbortSignal) =>
  api<{ items: ErasureAdminItem[] }>('/privacy/erasure-requests', { signal });

export const decideErasure = (id: string, action: 'approve' | 'reject' | 'cancel') =>
  api<{ request: ErasureRequest }>(`/privacy/erasure-requests/${id}/${action}`, {
    method: 'POST',
    body: {},
  });
