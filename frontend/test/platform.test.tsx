// @vitest-environment-options {"url": "http://admin.localhost:5173/"}
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, errorBody, member, platformMe, server, tenantDto } from './server';

const page = <T,>(items: T[]) => HttpResponse.json({ items, nextCursor: null });
const detail = (over = {}) => ({ ...tenantDto(), members: 12, activeAdmins: 2, ...over });

function signedInAsPlatformAdmin() {
  server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(platformMe)));
}

describe('platform area (admin host)', () => {
  it('opens on the list of colleges, with no college branding requests', async () => {
    signedInAsPlatformAdmin();
    let tenantInfoCalled = false;
    server.use(
      http.get(`${API}/tenant/info`, () => {
        tenantInfoCalled = true;
        return HttpResponse.json({});
      }),
      http.get(`${API}/platform/tenants`, () =>
        page([
          tenantDto(),
          tenantDto({
            id: 'c0000000-0000-7000-8000-000000000002',
            slug: 'beta',
            name: 'Beta Institute',
          }),
        ]),
      ),
    );
    const { router } = renderApp('/');
    expect((await screen.findAllByText('Beta Institute')).length).toBeGreaterThan(0);
    expect(router.state.location.pathname).toBe('/colleges');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Colleges');
    expect(nav).not.toHaveTextContent('Members'); // none of the college tools
    expect(tenantInfoCalled).toBe(false);
  });

  it('creates a college with its first admin invitation', async () => {
    signedInAsPlatformAdmin();
    let body: unknown;
    server.use(
      http.get(`${API}/platform/tenants`, () => page([])),
      http.post(`${API}/platform/tenants`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          {
            tenant: tenantDto({ name: 'Gamma College', slug: 'gamma' }),
            adminInvite: { outcome: 'invited', userId: 'u', membershipId: 'm' },
          },
          { status: 201 },
        );
      }),
    );
    const { user } = renderApp('/colleges');
    await user.click(await screen.findByRole('button', { name: 'Create college' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a college' });
    await user.click(
      within(dialog).getByRole('button', { name: 'Create and send the invitation' }),
    );
    expect(await within(dialog).findByText('College name is required.')).toBeInTheDocument();
    expect(body).toBeUndefined();

    await user.type(within(dialog).getByLabelText('College name'), 'Gamma College');
    await user.type(within(dialog).getByLabelText('Web address'), 'Gamma');
    await user.type(within(dialog).getByLabelText("First admin's name"), 'Gina Gamma');
    await user.type(within(dialog).getByLabelText("First admin's email"), 'gina@gamma.test');
    await user.click(
      within(dialog).getByRole('button', { name: 'Create and send the invitation' }),
    );
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Gamma College',
        slug: 'gamma',
        adminName: 'Gina Gamma',
        adminEmail: 'gina@gamma.test',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Gamma College was created');
  });

  it('shows the server message when the address is taken', async () => {
    signedInAsPlatformAdmin();
    server.use(
      http.get(`${API}/platform/tenants`, () => page([])),
      http.post(`${API}/platform/tenants`, () =>
        HttpResponse.json(
          errorBody('slug_taken', 'That web address is already used by another college'),
          { status: 409 },
        ),
      ),
    );
    const { user } = renderApp('/colleges');
    await user.click(await screen.findByRole('button', { name: 'Create college' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a college' });
    await user.type(within(dialog).getByLabelText('College name'), 'Dup');
    await user.type(within(dialog).getByLabelText('Web address'), 'alpha');
    await user.type(within(dialog).getByLabelText("First admin's name"), 'D');
    await user.type(within(dialog).getByLabelText("First admin's email"), 'd@dup.test');
    await user.click(
      within(dialog).getByRole('button', { name: 'Create and send the invitation' }),
    );
    expect(
      await screen.findByText('That web address is already used by another college'),
    ).toBeInTheDocument();
  });

  it('suspends a college only after a confirmation that names it, and reactivates it', async () => {
    signedInAsPlatformAdmin();
    const t = tenantDto();
    server.use(
      http.get(`${API}/platform/tenants/${t.id}`, () => HttpResponse.json(detail())),
      http.post(`${API}/platform/tenants/${t.id}/suspend`, () =>
        HttpResponse.json({ ...t, status: 'suspended' }),
      ),
      http.post(`${API}/platform/tenants/${t.id}/reactivate`, () => HttpResponse.json(t)),
    );
    const { user } = renderApp(`/colleges/${t.id}`);
    await user.click(await screen.findByRole('button', { name: 'Suspend college' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Alpha College?' });
    await user.click(within(dialog).getByRole('button', { name: 'Suspend Alpha College' }));
    expect(await screen.findByRole('button', { name: 'Reactivate college' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reactivate college' }));
    expect(await screen.findByRole('button', { name: 'Suspend college' })).toBeInTheDocument();
  });

  it('shows the members only on request, and tells that this is recorded', async () => {
    signedInAsPlatformAdmin();
    const t = tenantDto();
    let membersCalled = false;
    server.use(
      http.get(`${API}/platform/tenants/${t.id}`, () => HttpResponse.json(detail())),
      http.get(`${API}/platform/tenants/${t.id}/members`, () => {
        membersCalled = true;
        return page([member(1)]);
      }),
    );
    const { user } = renderApp(`/colleges/${t.id}`);
    await screen.findByRole('heading', { name: 'Alpha College' });
    expect(screen.getByText(/recorded in the audit log/)).toBeInTheDocument();
    expect(membersCalled).toBe(false); // not loaded (and so not audited) until someone asks
    await user.click(screen.getByRole('button', { name: 'Show members' }));
    expect((await screen.findAllByText('Person 1')).length).toBeGreaterThan(0);
    expect(membersCalled).toBe(true);
  });

  it('a 404 college is reported, not retried', async () => {
    signedInAsPlatformAdmin();
    server.use(
      http.get(`${API}/platform/tenants/c0000000-0000-7000-8000-0000000000ff`, () =>
        HttpResponse.json(errorBody('tenant_not_found', 'Tenant not found'), { status: 404 }),
      ),
    );
    renderApp('/colleges/c0000000-0000-7000-8000-0000000000ff');
    expect(await screen.findByText('This college does not exist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
