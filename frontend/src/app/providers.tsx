import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export function Providers({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return <QueryClientProvider client={client ?? defaultClient}>{children}</QueryClientProvider>;
}

const defaultClient = new QueryClient();
