// @vitest-environment-options {"url": "http://admin.localhost:5173/"}
import type { AccountErasureRequest } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { PlatformErasureItem } from '../src/features/privacy/privacy.erasure.api';
import { renderApp } from './render';
import { API, platformMe, server } from './server';

// Step 14b-1 part 4: the platform administrators' page for erasing the account of a person with no active membership (admin host).

const id = (n: number) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;
const req = (over: Partial<AccountErasureRequest> = {}): AccountErasureRequest => ({
  id: id(1),
  status: 'pending_approval',
  source: 'platform',
  requestedAt: '2026-03-10T09:00:00.000Z',
  expiresAt: '2026-04-09T09:00:00.000Z',
  graceUntil: null,
  ...over,
});
const mockSignedIn = (me: typeof platformMe) =>
  server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(me)));

describe('Account erasures (platform administrators)', () => {
  const item = (n: number, over: Partial<PlatformErasureItem> = {}): PlatformErasureItem => ({
    ...req({ id: id(n), status: 'pending_approval', source: 'platform' }),
    executedAt: null,
    requestedByName: 'Root',
    approvedByName: null,
    personName: `Person ${n}`,
    personEmail: `p${n}@old.test`,
    erased: false,
    canApprove: true,
    canCancel: true,
    ...over,
  });

  it('lists the requests; approving names the person and the 7 days; one you filed cannot be approved by you', async () => {
    mockSignedIn(platformMe);
    let decided: string | null = null;
    const items = [
      item(1),
      item(2, { canApprove: false, personName: 'Mine Filed' }),
      item(3, {
        status: 'done',
        erased: true,
        personEmail: null,
        personName: 'Former user AB12CD34',
        executedAt: '2026-03-20T09:00:00.000Z',
      }),
    ];
    server.use(
      http.get(`${API}/platform/account-erasures`, () =>
        HttpResponse.json({ items, hasMore: false }),
      ),
      http.post(`${API}/platform/account-erasures/:id/:action`, ({ params }) => {
        decided = `${params.id}:${params.action}`;
        return HttpResponse.json({
          request: req({ id: params.id as string, status: 'approved', source: 'platform' }),
        });
      }),
    );
    const { user } = renderApp('/account-erasures');
    expect(await screen.findByText(/Person 1 · p1@old.test/)).toBeInTheDocument();
    // the erased one shows the pseudonym and no address
    expect(screen.getByText(/Former user AB12CD34/)).toBeInTheDocument();
    expect(screen.queryByText(/Former user AB12CD34 ·/)).toBeNull();
    const mine = screen.getByText(/Mine Filed/).closest('li') as HTMLElement;
    expect(within(mine).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(mine).getByText(/A different administrator decides/)).toBeInTheDocument();
    const first = screen.getByText(/Person 1 · /).closest('li') as HTMLElement;
    await user.click(within(first).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/the account of Person 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/7 days/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decided).toBe(`${id(1)}:approve`));
  });

  it('files a request by address, shows the server message when the person is still a member, and has an empty state', async () => {
    mockSignedIn(platformMe);
    let filed: unknown = null;
    let attempts = 0;
    server.use(
      http.get(`${API}/platform/account-erasures`, () =>
        HttpResponse.json({ items: [], hasMore: false }),
      ),
      http.post(`${API}/platform/account-erasures`, async ({ request: r }) => {
        attempts += 1;
        filed = await r.json();
        return attempts === 1
          ? HttpResponse.json(
              {
                error: {
                  code: 'account_has_memberships',
                  message:
                    'This person is still a member of a college. Each college erases its own member first.',
                  requestId: 'r',
                },
              },
              { status: 409 },
            )
          : HttpResponse.json(
              { request: req({ source: 'platform', status: 'pending_approval' }) },
              { status: 202 },
            );
      }),
    );
    const { user } = renderApp('/account-erasures');
    expect(await screen.findByText('No requests')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'File the request' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Address of the account'), 'gone@old.test');
    await user.click(submit);
    await waitFor(() => expect(filed).toEqual({ email: 'gone@old.test' }));
    expect(await screen.findByText(/still a member of a college/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'File the request' }));
    expect(
      await screen.findByText(/A different platform administrator has to approve it/),
    ).toBeInTheDocument();
  });

  it('an error state offers a retry', async () => {
    mockSignedIn(platformMe);
    let calls = 0;
    server.use(
      http.get(`${API}/platform/account-erasures`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'boom', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({ items: [item(1)], hasMore: false });
      }),
    );
    const { user } = renderApp('/account-erasures');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Person 1 · /)).toBeInTheDocument();
  });
});
