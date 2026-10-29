import type { MemberListResponse, MeResponse } from '@lms/backend/contracts';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { departmentOptions, optionKeys } from '../features/academics/academics.api';
import { meKey } from '../features/auth/auth.api';
import { LoginPage } from '../features/auth/LoginPage';
import { loadMe, meQueryOptions } from '../features/auth/useMe';
import { listMembers, memberKeys } from '../features/members/members.api';
import { safeRedirect } from '../shared/utils/redirect';
import { AppShell } from './AppShell';
import { hostKind } from './host';
import { RootLayout } from './RootLayout';

// TanStack Router, code-based route tree. Why this router: typed and validated search params (the
// members filters live in the URL and can be shared), `defaultPreload: 'intent'` loads a route's code
// and data on hover/focus, and lazy route components give per-route chunks. Only the login page is in
// the entry chunk (it is what a visitor sees first); every other screen is a lazy chunk.

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: RootLayout });

// ---- public screens (no session needed)
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirect(search.redirect);
    return redirect ? { redirect } : {};
  },
  // already signed in (the session is in the cache): go to the app, no extra request on the login page
  beforeLoad: ({ context, search }) => {
    if (context.queryClient.getQueryData(meKey)) {
      throw redirect({ to: search.redirect ?? '/' });
    }
  },
  component: LoginPage,
});
const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: lazyRouteComponent(
    () => import('../features/auth/ForgotPasswordPage'),
    'ForgotPasswordPage',
  ),
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (s: Record<string, unknown>): { token?: string } =>
    typeof s.token === 'string' ? { token: s.token } : {},
  component: lazyRouteComponent(
    () => import('../features/auth/ResetPasswordPage'),
    'ResetPasswordPage',
  ),
});
const acceptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite',
  validateSearch: (s: Record<string, unknown>): { token?: string } =>
    typeof s.token === 'string' ? { token: s.token } : {},
  component: lazyRouteComponent(
    () => import('../features/auth/AcceptInvitePage'),
    'AcceptInvitePage',
  ),
});

// ---- signed-in frame
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const me = await loadMe((o) => context.queryClient.ensureQueryData(o));
    if (!me) {
      const back = safeRedirect(location.href);
      throw redirect({ to: '/login', search: back ? { redirect: back } : {} });
    }
    return { me };
  },
  component: AppShell,
});

/** Hide-and-redirect guard: the backend enforces permissions; this just avoids dead screens. */
function requires(permission: string) {
  return ({ context }: { context: RouterContext }) => {
    const me = context.queryClient.getQueryData<MeResponse>(meKey);
    if (!me?.permissions.includes(permission)) throw redirect({ to: '/' });
  };
}

const lazyPage = <T extends Record<string, unknown>>(
  load: () => Promise<T>,
  name: keyof T & string,
) => lazyRouteComponent(load as never, name as never);

const child = (
  path: string,
  component: ReturnType<typeof lazyPage>,
  permission?: string,
  extra = {},
) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component,
    ...(permission ? { beforeLoad: requires(permission) } : {}),
    ...extra,
  });

const homeRoute = child(
  '/',
  lazyPage(() => import('../features/dashboard/DashboardPage'), 'DashboardPage'),
);
// the platform area has no dashboard: its home is the list of colleges
const platformHomeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/colleges' as '/' });
  },
});

const meRoute = child(
  '/me',
  lazyPage(() => import('../features/me/MePage'), 'MePage'),
);

// Search params of the members list are the filters: validated here, shareable as a URL.
const membersSearch = (s: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of [
    'q',
    'role',
    'status',
    'profileType',
    'departmentId',
    'programId',
    'batchId',
    'sectionId',
  ]) {
    if (typeof s[k] === 'string' && s[k]) out[k] = s[k] as string;
  }
  return out;
};
const membersRoute = child(
  '/members',
  lazyPage(() => import('../features/members/MembersPage'), 'MembersPage'),
  'member.read',
  {
    validateSearch: membersSearch,
    // preload on hover/focus: start the first page and the department options (not awaited)
    loader: ({
      context,
      location,
    }: {
      context: RouterContext;
      location: { search: Record<string, unknown> };
    }) => {
      // with filters in the URL the page asks for exactly that list itself: do not fetch the plain one too
      if (Object.keys(location.search).length > 0) return;
      void context.queryClient.prefetchInfiniteQuery({
        queryKey: memberKeys.list({}),
        queryFn: ({ pageParam, signal }) => listMembers({}, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last: MemberListResponse) => last.nextCursor ?? undefined,
        pages: 1,
      });
      void context.queryClient.prefetchQuery({
        queryKey: optionKeys.departments,
        queryFn: ({ signal }) => departmentOptions(signal),
        staleTime: 5 * 60_000,
      });
    },
  },
);
const memberRoute = child(
  '/members/$userId',
  lazyPage(() => import('../features/members/MemberDetailPage'), 'MemberDetailPage'),
  'member.read',
);
const academicsRoute = child(
  '/academics',
  lazyPage(() => import('../features/academics/AcademicsPage'), 'AcademicsPage'),
  'academic.manage',
);
const importsRoute = child(
  '/imports',
  lazyPage(() => import('../features/imports/ImportsPage'), 'ImportsPage'),
  'import.run',
);
const importRoute = child(
  '/imports/$id',
  lazyPage(() => import('../features/imports/ImportDetailPage'), 'ImportDetailPage'),
  'import.run',
);
const auditRoute = child(
  '/audit',
  lazyPage(() => import('../features/audit/AuditPage'), 'CollegeAuditPage'),
  'audit.read',
);
const settingsRoute = child(
  '/settings',
  lazyPage(() => import('../features/settings/SettingsPage'), 'SettingsPage'),
  'tenant.manage',
);

const collegesRoute = child(
  '/colleges',
  lazyPage(() => import('../features/platform/CollegesPage'), 'CollegesPage'),
  'platform.tenant.read',
);
const collegeRoute = child(
  '/colleges/$id',
  lazyPage(() => import('../features/platform/CollegeDetailPage'), 'CollegeDetailPage'),
  'platform.tenant.read',
);
const platformAuditRoute = child(
  '/platform-audit',
  lazyPage(() => import('../features/audit/AuditPage'), 'PlatformAuditPage'),
  'platform.audit.read',
);

const publicRoutes = [loginRoute, forgotRoute, resetRoute, acceptRoute];

/**
 * ONE tree per host kind. addChildren() mutates the route objects it is called on, so the two trees
 * must never be built side by side: the one built last would silently replace the other's children.
 */
function buildRouteTree() {
  const children =
    hostKind === 'admin'
      ? [platformHomeRoute, collegesRoute, collegeRoute, platformAuditRoute]
      : [
          homeRoute,
          meRoute,
          membersRoute,
          memberRoute,
          academicsRoute,
          importsRoute,
          importRoute,
          auditRoute,
          settingsRoute,
        ];
  return rootRoute.addChildren([...publicRoutes, appRoute.addChildren(children)]);
}

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    ...(history ? { history } : {}),
    routeTree: buildRouteTree(),
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

export { meQueryOptions };
