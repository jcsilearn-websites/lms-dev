import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { logout } from '../features/auth/auth.api';
import { usePermissions } from '../features/auth/useMe';
import { useTenantInfo } from '../features/tenant/useTenantInfo';
import { hostKind } from './host';
import { getThemePref, setThemePref, type ThemePref } from './theme';

interface NavItem {
  to: string;
  label: string;
  /** shown when the user holds this permission (undefined = everyone signed in) */
  permission?: string;
}

const TENANT_NAV: NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/courses', label: 'Courses', permission: 'course.read' },
  { to: '/offerings', label: 'Offerings', permission: 'course.read' },
  { to: '/members', label: 'Members', permission: 'member.read' },
  { to: '/academics', label: 'Academic setup', permission: 'academic.manage' },
  { to: '/imports', label: 'Import', permission: 'import.run' },
  { to: '/audit', label: 'Audit log', permission: 'audit.read' },
  { to: '/settings', label: 'College settings', permission: 'tenant.manage' },
];

const PLATFORM_NAV: NavItem[] = [
  { to: '/colleges', label: 'Colleges', permission: 'platform.tenant.read' },
  { to: '/platform-audit', label: 'Audit log', permission: 'platform.audit.read' },
];

const navLink =
  'flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted sm:min-h-9 [&.active]:bg-muted [&.active]:text-primary';

function ThemeChoice() {
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const choose = (p: ThemePref) => {
    setThemePref(p);
    setPref(p);
  };
  return (
    <fieldset className="px-3 py-2">
      <legend className="mb-1 text-xs text-muted-foreground">Theme</legend>
      <div className="flex gap-1">
        {(['system', 'light', 'dark'] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={pref === p}
            onClick={() => choose(p)}
            className="min-h-9 flex-1 rounded-md border border-input px-2 text-xs capitalize aria-pressed:bg-primary aria-pressed:text-primary-foreground"
          >
            {p}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The signed-in frame: college name, navigation (permission based), user menu, sign out. */
export function AppShell() {
  const { me, has } = usePermissions();
  const info = useTenantInfo();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const items = (hostKind === 'admin' ? PLATFORM_NAV : TENANT_NAV).filter(
    (i) => !i.permission || has(i.permission),
  );
  const title = hostKind === 'admin' ? 'JCS iLearn platform' : (info.data?.displayName ?? ' ');

  const signOut = async () => {
    try {
      await logout();
    } catch {
      // the session may already be gone (401): leaving is the goal either way
    }
    qc.clear();
    await navigate({ to: '/login', replace: true });
  };

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
          <p className="min-w-0 flex-1 truncate text-base font-semibold">{title}</p>
          <nav aria-label="Main" className="hidden gap-1 md:flex">
            {items.map((i) => (
              <Link
                key={i.to}
                to={i.to as '/'}
                className={navLink}
                activeOptions={{ exact: i.to === '/' }}
              >
                {i.label}
              </Link>
            ))}
          </nav>
          <details className="relative">
            <summary className="flex min-h-11 list-none items-center rounded-md border border-input px-3 text-sm sm:min-h-9">
              <span className="max-w-32 truncate">{me?.user.displayName ?? 'Account'}</span>
            </summary>
            <div className="absolute right-0 z-40 mt-1 w-60 rounded-md border border-border bg-surface py-1 shadow-lg">
              <p className="truncate px-3 py-2 text-xs text-muted-foreground">{me?.user.email}</p>
              {hostKind === 'tenant' && (
                <Link to={'/me' as '/'} className={navLink}>
                  My profile
                </Link>
              )}
              <ThemeChoice />
              <button
                type="button"
                onClick={signOut}
                className="flex min-h-11 w-full items-center px-3 text-left text-sm hover:bg-muted sm:min-h-9"
              >
                Sign out
              </button>
            </div>
          </details>
        </div>
        <nav aria-label="Main (mobile)" className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {items.map((i) => (
            <Link
              key={i.to}
              to={i.to as '/'}
              className={`${navLink} shrink-0`}
              activeOptions={{ exact: i.to === '/' }}
            >
              {i.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
