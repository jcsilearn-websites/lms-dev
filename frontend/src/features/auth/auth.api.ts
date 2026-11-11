import type { Ack, LoginRequest, MeResponse, SessionList } from '@lms/backend/contracts';
import { ApiError, api } from '../../shared/api/client';

export const meKey = ['me'] as const;

const ME_SNAPSHOT = 'lms:me';
const snapshot = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};
export const forgetMe = () => {
  try {
    snapshot()?.removeItem(ME_SNAPSHOT);
  } catch {
    // storage blocked: nothing to forget
  }
};

/**
 * 401 here just means "not signed in": it must not trigger the sign-in redirect. The answer is kept for this TAB (not
 * across tabs, gone when the tab closes, removed at sign-out and at a 401) so that a reload while the API cannot be
 * reached (an exam taken on a bad connection) still opens the page the learner was on; every other call still fails
 * and says so.
 */
export const fetchMe = async (signal?: AbortSignal) => {
  try {
    const me = await api<MeResponse>('/auth/me', { signal, anonymousOk: true });
    try {
      snapshot()?.setItem(ME_SNAPSHOT, JSON.stringify(me));
    } catch {
      // quota or blocked: carry on without the safety net
    }
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      try {
        const kept = snapshot()?.getItem(ME_SNAPSHOT);
        if (kept) return JSON.parse(kept) as MeResponse;
      } catch {
        // unreadable: fall through to the original error
      }
    }
    if (err instanceof ApiError && err.status === 401) forgetMe();
    throw err;
  }
};

export const login = (body: LoginRequest) =>
  api<MeResponse>('/auth/login', { method: 'POST', body, anonymousOk: true });
export const logout = async () => {
  forgetMe();
  return api<Ack>('/auth/logout', { method: 'POST' });
};
export const forgotPassword = (email: string) =>
  api<Ack>('/auth/password/forgot', { method: 'POST', body: { email }, anonymousOk: true });
export const resetPassword = (token: string, newPassword: string) =>
  api<Ack>('/auth/password/reset', {
    method: 'POST',
    body: { token, newPassword },
    anonymousOk: true,
  });
export const acceptInvite = (token: string, password?: string) =>
  api<Ack>('/auth/invites/accept', {
    method: 'POST',
    body: password ? { token, password } : { token },
    anonymousOk: true,
  });
export const changePassword = (currentPassword: string, newPassword: string) =>
  api<Ack>('/auth/password/change', { method: 'POST', body: { currentPassword, newPassword } });
export const listSessions = () => api<SessionList>('/auth/sessions');
export const revokeSession = (id: string) => api<Ack>(`/auth/sessions/${id}`, { method: 'DELETE' });
