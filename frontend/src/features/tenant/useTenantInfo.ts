import { useQuery } from '@tanstack/react-query';
import { hostKind } from '../../app/host';
import { fetchTenantInfo, tenantInfoKey } from './tenant.api';

/** Public branding of the college behind this host. Not requested on the admin host. */
export function useTenantInfo() {
  return useQuery({
    queryKey: tenantInfoKey,
    queryFn: ({ signal }) => fetchTenantInfo(signal),
    enabled: hostKind === 'tenant',
    staleTime: 10 * 60_000,
    retry: false,
  });
}
