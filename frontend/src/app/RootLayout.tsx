import { Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { TenantNotFound } from '../features/tenant/TenantNotFound';
import { useTenantInfo } from '../features/tenant/useTenantInfo';
import { ApiError } from '../shared/api/client';
import { Toaster } from '../shared/ui/toast';
import { hostKind } from './host';
import { applyBrandColor } from './theme';

/**
 * Wraps every route: applies the college branding (colour + page title), shows the friendly 404 for a
 * college that does not exist or is suspended, and hosts the toast container.
 */
export function RootLayout() {
  const info = useTenantInfo();
  const color = info.data?.primaryColor;
  const name = info.data?.displayName;

  useEffect(() => {
    applyBrandColor(color);
  }, [color]);
  useEffect(() => {
    document.title = hostKind === 'admin' ? 'JCS iLearn platform' : (name ?? 'JCS iLearn');
  }, [name]);

  const missing =
    hostKind === 'tenant' && info.error instanceof ApiError && info.error.status === 404;
  return (
    <>
      {missing ? <TenantNotFound /> : <Outlet />}
      <Toaster />
    </>
  );
}
