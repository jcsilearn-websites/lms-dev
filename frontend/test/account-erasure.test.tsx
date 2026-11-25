import type { AccountErasureRequest } from '@lms/backend/contracts';
import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// Step 14b-1 part 4, erasure of the whole account: the member's card on "My data" (only while this is the person's ONE college), and the
// platform administrators' page (file by address, a different administrator approves, every action names the person).

const id = (n: number) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;
const req = (over: Partial<AccountErasureRequest> = {}): AccountErasureRequest => ({
  id: id(1),
  status: 'waiting_college',
  source: 'member_combined',
  requestedAt: '2026-03-10T09:00:00.000Z',
  expiresAt: '2026-04-09T09:00:00.000Z',
  graceUntil: null,
  ...over,
});
const myData = () => {
  server.use(
    http.get(`${API}/me/data-exports`, () => HttpResponse.json({ items: [] })),
    http.get(`${API}/me/erasure/preview`, () =>
      HttpResponse.json({
        lastAdmin: false,
        open: null,
        erased: {},
        kept: {},
        rules: {
          requestExpiresAfterDays: 30,
          graceDays: 7,
          backupRetentionDays: 30,
          exportRetentionDays: 7,
        },
      }),
    ),
  );
};
const askLabel = 'Ask to erase my whole account';
const pwLabel = 'Password to confirm your account erasure';

describe('Erase my whole account (member)', () => {
  it('a member of several colleges is told what to do instead, and there is no form', async () => {
    mockSignedIn(memberMe);
    myData();
    server.use(
      http.get(`${API}/me/account-erasure`, () =>
        HttpResponse.json({ request: null, eligible: false, colleges: 3 }),
      ),
    );
    renderApp('/me/data');
    expect(await screen.findByText(/You belong to 3 colleges/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: askLabel })).toBeNull();
  });

  it('the one college: needs the password and the confirmation, sends them, then shows the request waiting for the college', async () => {
    mockSignedIn(memberMe);
    myData();
    let sent: unknown = null;
    server.use(
      http.get(`${API}/me/account-erasure`, () =>
        HttpResponse.json({ request: null, eligible: true, colleges: 1 }),
      ),
      http.post(`${API}/me/account-erasure`, async ({ request: r }) => {
        sent = await r.json();
        return HttpResponse.json(
          { request: req(), collegeRequest: null, alreadyInProgress: false },
          { status: 202 },
        );
      }),
    );
    const { user } = renderApp('/me/data');
    const button = await screen.findByRole('button', { name: askLabel });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(pwLabel), 'secret-pass-1');
    expect(button).toBeDisabled(); // the password alone is not enough
    await user.click(
      screen.getByRole('checkbox', { name: /I understand that my whole account will be erased/ }),
    );
    await user.click(button);
    await waitFor(() => expect(sent).toEqual({ password: 'secret-pass-1' }));
    expect(await screen.findByText('You asked to erase your whole account.')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the college')).toBeInTheDocument();
    expect(screen.getByText(/cancelling it also cancels this/)).toBeInTheDocument();
  });

  it('a wrong password shows the server message and keeps the form', async () => {
    mockSignedIn(memberMe);
    myData();
    server.use(
      http.get(`${API}/me/account-erasure`, () =>
        HttpResponse.json({ request: null, eligible: true, colleges: 1 }),
      ),
      http.post(`${API}/me/account-erasure`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'invalid_current_password',
              message: 'The current password is incorrect',
              requestId: 'r',
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { user } = renderApp('/me/data');
    await user.type(await screen.findByLabelText(pwLabel), 'wrong');
    await user.click(screen.getByRole('checkbox', { name: /I understand that my whole account/ }));
    await user.click(screen.getByRole('button', { name: askLabel }));
    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: askLabel })).toBeInTheDocument();
  });

  it('an open request says so and offers no second form; an error state offers a retry', async () => {
    mockSignedIn(memberMe);
    myData();
    let calls = 0;
    server.use(
      http.get(`${API}/me/account-erasure`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'boom', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({
              request: req({ status: 'approved' }),
              eligible: true,
              colleges: 1,
            });
      }),
    );
    const { user } = renderApp('/me/data');
    const retry = await screen.findAllByRole('button', { name: 'Try again' });
    await user.click(retry.at(-1) as HTMLElement);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: askLabel })).not.toBeInTheDocument();
  });
});
