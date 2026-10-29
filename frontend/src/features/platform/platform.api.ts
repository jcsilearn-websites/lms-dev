import type {
  AdminInviteRequest,
  AdminInviteResponse,
  CreateTenantRequest,
  CreateTenantResponse,
  MemberListResponse,
  TenantDetail,
  TenantDto,
  TenantList,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

export const platformKeys = {
  list: (q: string) => ['platform', 'tenants', q] as const,
  all: ['platform', 'tenants'] as const,
  detail: (id: string) => ['platform', 'tenant', id] as const,
  members: (id: string) => ['platform', 'tenant', id, 'members'] as const,
};

export const listTenants = (q: string, after: string | undefined, signal?: AbortSignal) =>
  api<TenantList>('/platform/tenants', {
    signal,
    query: { q: q.length >= 2 ? q : undefined, limit: 25, after },
  });
export const getTenant = (id: string, signal?: AbortSignal) =>
  api<TenantDetail>(`/platform/tenants/${id}`, { signal });
export const createTenant = (body: CreateTenantRequest) =>
  api<CreateTenantResponse>('/platform/tenants', { method: 'POST', body });
export const renameTenant = (id: string, name: string) =>
  api<TenantDto>(`/platform/tenants/${id}`, { method: 'PATCH', body: { name } });
export const suspendTenant = (id: string) =>
  api<TenantDto>(`/platform/tenants/${id}/suspend`, { method: 'POST' });
export const reactivateTenant = (id: string) =>
  api<TenantDto>(`/platform/tenants/${id}/reactivate`, { method: 'POST' });
export const inviteTenantAdmin = (id: string, body: AdminInviteRequest) =>
  api<AdminInviteResponse>(`/platform/tenants/${id}/admin-invite`, { method: 'POST', body });
export const tenantMembers = (id: string, after: string | undefined, signal?: AbortSignal) =>
  api<MemberListResponse>(`/platform/tenants/${id}/members`, {
    signal,
    query: { limit: 25, after },
  });
