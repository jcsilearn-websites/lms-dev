import type { ReactElement } from 'react';
import { HealthPanel } from '../features/health';

// A deliberately tiny router: one page today. Swap for a real router when a second page exists.
const routes: Record<string, () => ReactElement> = {
  '/': () => <HealthPanel />,
};

export function Router({ pathname = window.location.pathname }: { pathname?: string }) {
  const page = routes[pathname];
  return page ? page() : <p>Page not found</p>;
}
