import type { Ack, LoginRequest, MeResponse, SessionList } from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

export const meKey = ['me'] as const;

/** 401 here just means "not signed in": it must not trigger the sign-in redirect. */
export const fetchMe = (signal?: AbortSignal) =>
  api<MeResponse>('/auth/me', { signal, anonymousOk: true });

export const login = (body: LoginRequest) =>
  api<MeResponse>('/auth/login', { method: 'POST', body, anonymousOk: true });
export const logout = () => api<Ack>('/auth/logout', { method: 'POST' });
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
