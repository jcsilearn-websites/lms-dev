import type { TenantInfo, UpdateBrandingRequest } from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

export const tenantInfoKey = ['tenant-info'] as const;

export const fetchTenantInfo = (signal?: AbortSignal) =>
  api<TenantInfo>('/tenant/info', { signal, anonymousOk: true });

export const updateBranding = (body: UpdateBrandingRequest) =>
  api<TenantInfo>('/tenant/branding', { method: 'PATCH', body });
