// @vitest-environment-options {"url": "http://admin.localhost:5173/"}
import type { MfaResetItem } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, errorBody, platformMe, server } from './server';

// Step 14c part 3: the platform administrators' page for resetting a lost second factor (admin host).

const me = { ...platformMe, permissions: [...platformMe.permissions, 'platform.mfa_reset.manage'] };
const id = (n: number) => `00000000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
const item = (n: number, over: Partial<MfaResetItem> = {}): MfaResetItem => ({
  id: id(n),
  status: 'pending_approval',
  requestedAt: '2026-03-10T09:00:00.000Z',
  expiresAt: '2026-03-17T09:00:00.000Z',
  executeAfter: null,
  executedAt: null,
  reason: null,
  personName: `Person ${n}`,
  personEmail: `p${n}@alpha.test`,
  requestedByName: 'Root',
  approvedByName: null,
  canApprove: true,
  canCancel: true,
  ...over,
});
const signedIn = () => server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(me)));

describe('Two-step sign-in resets (platform administrators)', () => {
  it('approving names the person and the 24 hours; a request you filed is not yours to approve; more pages load', async () => {
    signedIn();
    let decided: string | null = null;
    server.use(
      http.get(`${API}/platform/mfa-resets`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        return HttpResponse.json(
          after
            ? {
                items: [
                  item(3, {
                    status: 'cancelled',
                    reason: 'subject_signed_in',
                    canApprove: false,
                    canCancel: false,
                  }),
                ],
                nextCursor: null,
              }
            : {
                items: [item(1), item(2, { personName: 'Mine Filed', canApprove: false })],
                nextCursor: id(2),
              },
        );
      }),
      http.post(`${API}/platform/mfa-resets/:id/:action`, ({ params }) => {
        decided = `${params.id}:${params.action}`;
        return HttpResponse.json({
          request: {
            id: params.id,
            status: 'approved',
            requestedAt: '2026-03-10T09:00:00.000Z',
            expiresAt: '2026-03-17T09:00:00.000Z',
            executeAfter: '2026-03-11T09:00:00.000Z',
          },
        });
      }),
    );
    const { user } = renderApp('/platform/mfa-resets');
    const first = (await screen.findByText('Person 1 (p1@alpha.test)')).closest(
      'li',
    ) as HTMLElement;
    const mine = screen.getByText(/Mine Filed/).closest('li') as HTMLElement;
    expect(within(mine).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(mine).getByText(/A different administrator decides/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await screen.findByText(/the person signed in with their second step/),
    ).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Person 1 (p1@alpha.test)');
    expect(dialog).toHaveTextContent('24 hours');
    await user.click(within(dialog).getByRole('button', { name: 'Approve reset' }));
    await waitFor(() => expect(decided).toBe(`${id(1)}:approve`));
  });

  it('files by address, shows the refusal in words, and has an empty state', async () => {
    signedIn();
    let filed: unknown = null;
    server.use(
      http.get(`${API}/platform/mfa-resets`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(`${API}/platform/mfa-resets`, async ({ request }) => {
        filed = await request.json();
        return HttpResponse.json(
          errorBody('mfa_not_enrolled', 'This account has no second factor to reset'),
          { status: 409 },
        );
      }),
    );
    const { user } = renderApp('/platform/mfa-resets');
    expect(await screen.findByText('No reset requests')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Address of the account'), ' lost@alpha.test ');
    await user.click(screen.getByRole('button', { name: 'File the request' }));
    expect(
      await screen.findByText('This account has no second factor to reset'),
    ).toBeInTheDocument();
    expect(filed).toEqual({ email: 'lost@alpha.test' });
  });
});
