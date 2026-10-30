import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import {
  API,
  adminMe,
  errorBody,
  memberMe,
  mockSignedIn,
  mockSignedOut,
  server,
  tenantInfo,
} from './server';

describe('sign in', () => {
  it('shows the college name and signs in, then lands on the home page', async () => {
    mockSignedOut();
    let body: unknown;
    server.use(
      http.post(`${API}/auth/login`, async ({ request }) => {
        body = await request.json();
        // from now on /auth/me answers: the session exists
        server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(adminMe)));
        return HttpResponse.json(adminMe);
      }),
    );
    const { user } = renderApp('/login');
    expect(await screen.findByText(tenantInfo.displayName)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'admin@alpha.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Welcome, Ada Admin/ })).toBeInTheDocument();
    expect(body).toEqual({ email: 'admin@alpha.test', password: 'correct horse battery' });
  });

  it('says so, without detail, when the password is wrong', async () => {
    mockSignedOut();
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(errorBody('invalid_credentials', 'Invalid email or password'), {
          status: 401,
        }),
      ),
    );
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'admin@alpha.test');
    await user.type(screen.getByLabelText('Password'), 'wrong password!!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
    // still on the login page, nothing cleared
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('validates with the contract schema before calling the API', async () => {
    mockSignedOut();
    let called = false;
    server.use(
      http.post(`${API}/auth/login`, () => {
        called = true;
        return HttpResponse.json(adminMe);
      }),
    );
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Email is required.');
    expect(called).toBe(false);
  });

  it('goes back to the page the person wanted after signing in', async () => {
    mockSignedOut();
    server.use(
      http.post(`${API}/auth/login`, () => {
        server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(adminMe)));
        return HttpResponse.json(adminMe);
      }),
      http.get(`${API}/imports`, () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    const { user, router } = renderApp('/imports');
    // not signed in: the guard sends the visitor to login and remembers where they were going
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ redirect: '/imports' });
    await user.type(await screen.findByLabelText('Email'), 'admin@alpha.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Bulk import' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/imports');
  });

  it('ignores a ?redirect= that points outside the app', async () => {
    mockSignedOut();
    server.use(
      http.post(`${API}/auth/login`, () => {
        server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(adminMe)));
        return HttpResponse.json(adminMe);
      }),
    );
    const { user, router } = renderApp(`/login?redirect=${encodeURIComponent('//evil.test/x')}`);
    await user.type(await screen.findByLabelText('Email'), 'admin@alpha.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: /Welcome/ });
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('a college that does not exist', () => {
  it('shows the friendly 404 instead of a broken page', async () => {
    server.use(
      http.get(`${API}/tenant/info`, () =>
        HttpResponse.json(errorBody('tenant_not_found', 'Tenant not found'), { status: 404 }),
      ),
      http.get(`${API}/auth/me`, () =>
        HttpResponse.json(errorBody('tenant_not_found', 'Tenant not found'), { status: 404 }),
      ),
    );
    renderApp('/login');
    expect(
      await screen.findByRole('heading', { name: 'We could not find this college' }),
    ).toBeInTheDocument();
  });
});

describe('a session that ends while the app is open', () => {
  it('clears everything and goes to login, remembering the page', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/imports`, () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    const { router, queryClient } = renderApp('/imports');
    await screen.findByRole('heading', { name: 'Bulk import' });
    expect(queryClient.getQueryData(['me'])).toBeTruthy();

    // the session expires: the next call is a 401
    server.use(
      http.get(`${API}/audit`, () =>
        HttpResponse.json(errorBody('unauthenticated', 'Authentication required'), { status: 401 }),
      ),
      http.get(`${API}/auth/me`, () =>
        HttpResponse.json(errorBody('unauthenticated', 'Authentication required'), { status: 401 }),
      ),
    );
    void router.navigate({ to: '/audit' as '/' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ redirect: '/audit' });
    expect(queryClient.getQueryData(['me'])).toBeUndefined();
  });
});

describe('what the navigation shows', () => {
  it('an institution admin sees the admin tools', async () => {
    mockSignedIn(adminMe);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of [
      'Home',
      'Members',
      'Academic setup',
      'Import',
      'Audit log',
      'College settings',
    ]) {
      expect(nav).toHaveTextContent(name);
    }
  });

  it('a member sees only Home and the "not in any course" message; admin URLs bounce home', async () => {
    mockSignedIn(memberMe);
    const { router } = renderApp('/members');
    expect(await screen.findByText('You are not in any course yet')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Home');
    expect(nav).not.toHaveTextContent('Members');
    expect(nav).not.toHaveTextContent('Import');
  });

  it('applies the college colour, per theme, only where it is readable', async () => {
    mockSignedIn(adminMe);
    server.use(
      http.get(`${API}/tenant/info`, () =>
        HttpResponse.json({ ...tenantInfo, primaryColor: '#fde68a' }),
      ),
    );
    renderApp('/');
    await screen.findByRole('heading', { name: /Welcome/ });
    const style = document.documentElement.style;
    // a pale yellow: too light for the light theme (fallback: the variable stays unset), fine on dark
    await waitFor(() => expect(style.getPropertyValue('--primary-d')).toBe('#fde68a'));
    expect(style.getPropertyValue('--primary-l')).toBe('');
  });
});
