import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Providers } from '../src/app/providers';
import { createAppRouter } from '../src/app/router';
import { setUnauthorizedHandler } from '../src/shared/api/client';
import { safeRedirect } from '../src/shared/utils/redirect';

/** The whole app (router + providers) at a URL, with a fresh cache and the real 401 handling. */
export function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } },
  });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  // the same behaviour as main.tsx: a 401 of a signed-in call clears the cache and goes to login
  setUnauthorizedHandler(() => {
    queryClient.clear();
    const here = router.state.location;
    if (here.pathname === '/login') return;
    const back = safeRedirect(here.pathname + (here.searchStr ?? ''));
    void router.navigate({ to: '/login', search: back ? { redirect: back } : {}, replace: true });
  });
  // our own file-type check is under test: do not let user-event filter by the accept attribute
  const user = userEvent.setup({ applyAccept: false });
  const utils = render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...utils, router, queryClient, user };
}
