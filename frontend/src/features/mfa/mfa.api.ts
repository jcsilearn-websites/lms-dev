import type {
  Ack,
  MeResponse,
  MfaEnrolConfirmResponse,
  MfaEnrolStartResponse,
  MfaRecoveryCodesResponse,
  MfaResetList,
  MfaResetResult,
  MfaStatus,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';
import type { SecondFactor } from '../../shared/mfa/CodeForm';

// Two-step sign-in (step 14c). The public calls answer 401 for a wrong code or an ended attempt: that is an ordinary answer
// there (`anonymousOk`), never a reason to sign anybody out.

export const mfaKeys = {
  status: ['me', 'mfa'] as const,
  resets: ['platform', 'mfa-resets'] as const,
};

export const verifySecondFactor = (factor: SecondFactor) =>
  api<MeResponse>('/auth/mfa/verify', { method: 'POST', body: factor, anonymousOk: true });
export const startEnrolment = (token: string, password: string) =>
  api<MfaEnrolStartResponse>('/auth/mfa/enrol/start', {
    method: 'POST',
    body: { token, password },
    anonymousOk: true,
  });
export const confirmEnrolment = (code: string) =>
  api<MfaEnrolConfirmResponse>('/auth/mfa/enrol/confirm', {
    method: 'POST',
    body: { code },
    anonymousOk: true,
  });

export const getMfaStatus = (signal?: AbortSignal) => api<MfaStatus>('/me/mfa', { signal });
// each of these asks for a step-up: the API client opens the dialog and repeats the call
export const startReplacement = () =>
  api<MfaEnrolStartResponse>('/me/mfa/replace/start', { method: 'POST' });
export const confirmReplacement = (code: string) =>
  api<Ack>('/me/mfa/replace/confirm', { method: 'POST', body: { code } });
export const newRecoveryCodes = () =>
  api<MfaRecoveryCodesResponse>('/me/mfa/recovery-codes', { method: 'POST' });
export const disableMfa = () => api<Ack>('/me/mfa/disable', { method: 'POST' });

export const listMfaResets = (after: string | undefined, signal?: AbortSignal) =>
  api<MfaResetList>('/platform/mfa-resets', { signal, query: { limit: 25, after } });
export const fileMfaReset = (email: string) =>
  api<MfaResetResult>('/platform/mfa-resets', { method: 'POST', body: { email } });
export const decideMfaReset = (id: string, action: 'approve' | 'reject' | 'cancel') =>
  api<MfaResetResult>(`/platform/mfa-resets/${id}/${action}`, { method: 'POST' });
