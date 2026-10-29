import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, errorBody, mockSignedIn, server, studentProfile, tenantInfo } from './server';

describe('college settings (branding)', () => {
  it('saves, applies the new colour at once and updates the cached tenant info', async () => {
    mockSignedIn();
    let body: unknown;
    server.use(
      http.patch(`${API}/tenant/branding`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          slug: 'alpha',
          displayName: 'Alpha Institute',
          primaryColor: '#7c3aed',
        });
      }),
    );
    const { user, queryClient } = renderApp('/settings');
    const name = await screen.findByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Alpha Institute');
    const colour = screen.getByLabelText('Primary colour');
    await user.clear(colour);
    await user.type(colour, '#7C3AED');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() =>
      expect(body).toEqual({ displayName: 'Alpha Institute', primaryColor: '#7c3aed' }),
    );
    expect(await screen.findByText('Branding saved.')).toBeInTheDocument();
    expect(queryClient.getQueryData(['tenant-info'])).toMatchObject({
      displayName: 'Alpha Institute',
    });
    // violet passes AA on the light page but not on the dark one: the light theme gets the college
    // colour, the dark theme keeps its default (the variable stays unset)
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary-l')).toBe('#7c3aed'),
    );
    expect(document.documentElement.style.getPropertyValue('--primary-d')).toBe('');
  });

  it('rejects an invalid colour with the contract rule, before the API', async () => {
    mockSignedIn();
    let called = false;
    server.use(
      http.patch(`${API}/tenant/branding`, () => {
        called = true;
        return HttpResponse.json(tenantInfo);
      }),
    );
    const { user } = renderApp('/settings');
    const colour = await screen.findByLabelText('Primary colour');
    await user.clear(colour);
    await user.type(colour, 'red');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByText('Primary colour has an invalid format.')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('warns when a colour is unreadable on one theme and says which default is used', async () => {
    mockSignedIn();
    const { user } = renderApp('/settings');
    const colour = await screen.findByLabelText('Primary colour');
    await user.clear(colour);
    await user.type(colour, '#fde68a');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'too light to read on the light theme',
    );
    await user.clear(colour);
    await user.type(colour, '#1e3a8a');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'too dark to read on the dark theme',
    );
  });
});

describe('my account', () => {
  it('shows my profile, and says so when there is none', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/me/profile`, () =>
        HttpResponse.json(studentProfile('00000000-0000-7000-8000-000000000001')),
      ),
      http.get(`${API}/auth/sessions`, () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    renderApp('/me');
    expect(await screen.findByText('R-1')).toBeInTheDocument();
    expect(screen.getByText('2023-2027')).toBeInTheDocument();
  });

  it('changes the password only when both entries match, and reports a wrong current password', async () => {
    mockSignedIn();
    let sent: unknown;
    server.use(
      http.get(`${API}/me/profile`, () =>
        HttpResponse.json(errorBody('profile_not_found', 'none'), { status: 404 }),
      ),
      http.get(`${API}/auth/sessions`, () => HttpResponse.json({ items: [], nextCursor: null })),
      http.post(`${API}/auth/password/change`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(errorBody('invalid_credentials', 'Invalid email or password'), {
          status: 401,
        });
      }),
    );
    const { user } = renderApp('/me');
    expect(await screen.findByText(/has not set up your profile yet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), 'old password 123');
    await user.type(screen.getByLabelText('New password'), 'a brand new password');
    await user.type(screen.getByLabelText('Repeat the new password'), 'a different one!!');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(sent).toBeUndefined();

    await user.clear(screen.getByLabelText('Repeat the new password'));
    await user.type(screen.getByLabelText('Repeat the new password'), 'a brand new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() =>
      expect(sent).toEqual({
        currentPassword: 'old password 123',
        newPassword: 'a brand new password',
      }),
    );
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();
  });

  it('signs out another session and drops just that row; this device cannot sign itself out here', async () => {
    mockSignedIn();
    const s = (id: string, current: boolean) => ({
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-02T00:00:00.000Z',
      ip: '10.0.0.1',
      userAgent: current ? 'Chrome on this laptop' : 'Safari on a phone',
      current,
    });
    let lists = 0;
    server.use(
      http.get(`${API}/me/profile`, () =>
        HttpResponse.json(errorBody('profile_not_found', 'none'), { status: 404 }),
      ),
      http.get(`${API}/auth/sessions`, () => {
        lists += 1;
        return HttpResponse.json({
          items: [
            s('a0000000-0000-7000-8000-000000000001', true),
            s('a0000000-0000-7000-8000-000000000002', false),
          ],
          nextCursor: null,
        });
      }),
      http.delete(`${API}/auth/sessions/a0000000-0000-7000-8000-000000000002`, () =>
        HttpResponse.json({ status: 'ok' }),
      ),
    );
    const { user } = renderApp('/me');
    await screen.findByText('Safari on a phone');
    expect(screen.getByText('this device')).toBeInTheDocument();
    const card = screen
      .getByRole('heading', { name: 'My sessions' })
      .closest('section') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Safari on a phone')).not.toBeInTheDocument());
    expect(screen.getByText('Chrome on this laptop')).toBeInTheDocument();
    expect(lists).toBe(1);
  });
});
