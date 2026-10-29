import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Providers } from './app/providers';
import { createQueryClient } from './app/queryClient';
import { createAppRouter } from './app/router';
import { applyThemePref } from './app/theme';
import { setUnauthorizedHandler } from './shared/api/client';
import { safeRedirect } from './shared/utils/redirect';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

applyThemePref();
const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

// A 401 on a signed-in call means the session ended (expired, revoked, signed out elsewhere): drop
// everything cached for that person and go to the sign-in page, remembering where they were.
setUnauthorizedHandler(() => {
  queryClient.clear();
  const here = router.state.location;
  if (here.pathname === '/login') return;
  const back = safeRedirect(here.pathname + (here.searchStr ?? ''));
  void router.navigate({ to: '/login', search: back ? { redirect: back } : {}, replace: true });
});

createRoot(root).render(
  <StrictMode>
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
