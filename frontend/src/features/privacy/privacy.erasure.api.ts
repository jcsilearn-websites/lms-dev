import type {
  AccountErasureRequest,
  ErasurePreview,
  ErasureRequest,
  RequestErasure,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

// Typed with the backend contracts (step 14b-1, erasure inside a college).

export type ErasureAdminItem = ErasureRequest & {
  memberName: string;
  memberEmail: string;
  withAccount: boolean;
};

export const erasureKeys = {
  preview: ['privacy', 'erasure', 'preview'] as const,
  admin: ['privacy', 'erasure', 'admin'] as const,
  account: ['privacy', 'account-erasure'] as const,
  platform: ['platform', 'account-erasures'] as const,
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

// ---- erasure of the whole account (part 4)
export interface MyAccountErasure {
  request: AccountErasureRequest | null;
  /** this college is the person's ONLY one */
  eligible: boolean;
  colleges: number;
}
export const getMyAccountErasure = (signal?: AbortSignal) =>
  api<MyAccountErasure>('/me/account-erasure', { signal });

/** Combined: the college erasure (an administrator approves it), then the account. The password is asked again by the server. */
export const requestAccountErasure = (body: RequestErasure) =>
  api<{
    request: AccountErasureRequest;
    collegeRequest: ErasureRequest | null;
    alreadyInProgress: boolean;
  }>('/me/account-erasure', { method: 'POST', body });

export type PlatformErasureItem = AccountErasureRequest & {
  executedAt: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  personName: string;
  personEmail: string | null;
  erased: boolean;
  canApprove: boolean;
  canCancel: boolean;
};
export const listAccountErasures = (signal?: AbortSignal) =>
  api<{ items: PlatformErasureItem[]; hasMore: boolean }>('/platform/account-erasures', { signal });
export const fileAccountErasure = (email: string) =>
  api<{ request: AccountErasureRequest }>('/platform/account-erasures', {
    method: 'POST',
    body: { email },
  });
export const decideAccountErasure = (id: string, action: 'approve' | 'reject' | 'cancel') =>
  api<{ request: AccountErasureRequest }>(`/platform/account-erasures/${id}/${action}`, {
    method: 'POST',
    body: {},
  });
