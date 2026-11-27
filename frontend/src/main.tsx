import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ErrorBoundary } from './app/ErrorBoundary';
import { Providers } from './app/providers';
import { createQueryClient } from './app/queryClient';
import { createAppRouter } from './app/router';
import { applyThemePref } from './app/theme';
import { setUnauthorizedHandler } from './shared/api/client';
import { installGlobalErrorHandlers } from './shared/errors/clientErrors';
import { safeRedirect } from './shared/utils/redirect';
import { clearServiceWorkerCaches } from './sw/clearCaches';
import { scheduleServiceWorker } from './sw/register';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

applyThemePref();
installGlobalErrorHandlers();
const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

// A 401 on a signed-in call means the session ended (expired, revoked, signed out elsewhere): drop
// everything cached for that person and go to the sign-in page, remembering where they were.
setUnauthorizedHandler(() => {
  queryClient.clear();
  void clearServiceWorkerCaches(); // the session is over: nothing it touched stays in a cache
  const here = router.state.location;
  if (here.pathname === '/login') return;
  const back = safeRedirect(here.pathname + (here.searchStr ?? ''));
  void router.navigate({ to: '/login', search: back ? { redirect: back } : {}, replace: true });
});

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers client={queryClient}>
        <RouterProvider router={router} />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
);

// after the first render, in idle time once the page has loaded (never on the path of the first paint)
scheduleServiceWorker();
