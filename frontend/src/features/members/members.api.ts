import type {
  Ack,
  Member,
  MemberListResponse,
  MoveSectionResponse,
  ProfileDto,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

export interface MemberFilters {
  q?: string | undefined;
  role?: string | undefined;
  status?: string | undefined;
  profileType?: string | undefined;
  departmentId?: string | undefined;
  /** UI-only step of the cascade (department -> program -> batch -> section); not an API filter */
  programId?: string | undefined;
  batchId?: string | undefined;
  sectionId?: string | undefined;
}

export const PAGE_SIZE = 25;

export const memberKeys = {
  all: ['members'] as const,
  list: (filters: MemberFilters) => ['members', 'list', filters] as const,
  detail: (userId: string) => ['members', 'detail', userId] as const,
  profile: (userId: string) => ['members', 'profile', userId] as const,
};

export function listMembers(
  filters: MemberFilters,
  after: string | undefined,
  signal?: AbortSignal,
) {
  const { programId: _ui, q, ...rest } = filters;
  return api<MemberListResponse>('/members', {
    signal,
    query: { ...rest, q: q && q.length >= 2 ? q : undefined, limit: PAGE_SIZE, after },
  });
}

export const getMember = (userId: string, signal?: AbortSignal) =>
  api<Member>(`/members/${userId}`, { signal });
export const getProfile = (userId: string, signal?: AbortSignal) =>
  api<ProfileDto>(`/members/${userId}/profile`, { signal });

export const changeRole = (userId: string, role: 'institution_admin' | 'member') =>
  api<Member>(`/members/${userId}/role`, { method: 'PATCH', body: { role } });
export const suspendMember = (userId: string) =>
  api<Member>(`/members/${userId}/suspend`, { method: 'POST' });
export const reactivateMember = (userId: string) =>
  api<Member>(`/members/${userId}/reactivate`, { method: 'POST' });
export const removeMember = (userId: string) =>
  api<Ack>(`/members/${userId}`, { method: 'DELETE' });
export const resendInvite = (userId: string) =>
  api<Ack>(`/members/${userId}/resend-invite`, { method: 'POST' });
export const unlockMember = (userId: string) =>
  api<Ack>(`/auth/members/${userId}/unlock`, { method: 'POST' });
export const inviteMember = (body: {
  email: string;
  role: 'institution_admin' | 'member';
  displayName?: string | undefined;
}) => api<Ack>('/auth/invites', { method: 'POST', body });

export const saveProfile = (userId: string, body: Record<string, unknown>) =>
  api<ProfileDto>(`/members/${userId}/profile`, { method: 'PATCH', body });
export const moveSection = (userId: string, sectionId: string) =>
  api<MoveSectionResponse>(`/members/${userId}/profile/section`, {
    method: 'POST',
    body: { sectionId },
  });
