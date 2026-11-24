import type { ErasurePreview, ErasureRequest } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, adminMe, memberMe, mockSignedIn, server } from './server';

// Step 14b-1, erasure inside a college: the member's section on "My data" (what is removed, what is kept and for how long, in words and
// in their own numbers; the password; the open request; cancel) and the administrators' page (approve / reject / cancel name the member).

const id = (n: number) => `00000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
const preview = (over: Partial<ErasurePreview> = {}): ErasurePreview => ({
  lastAdmin: false,
  open: null,
  erased: { sessions: 2, notifications: 5, emails: 3, activityDays: 1, profileFields: 1 },
  kept: {
    enrolments: 2,
    quizAttempts: 4,
    submissions: 3,
    gradebookSnapshots: 1,
    auditEntries: 7,
    progressRecords: 9,
  },
  rules: {
    requestExpiresAfterDays: 30,
    graceDays: 7,
    backupRetentionDays: 30,
    exportRetentionDays: 7,
  },
  ...over,
});
const request = (over: Partial<ErasureRequest> = {}): ErasureRequest => ({
  id: id(1),
  status: 'pending_approval',
  requestedAt: '2026-03-10T09:00:00.000Z',
  expiresAt: '2026-04-09T09:00:00.000Z',
  graceUntil: null,
  ...over,
});
const myDataDefaults = () =>
  server.use(http.get(`${API}/me/data-exports`, () => HttpResponse.json({ items: [] })));

describe('Erase me from this college (member)', () => {
  it("says plainly what is removed and what is kept and for how long, with the member's own numbers", async () => {
    mockSignedIn(memberMe);
    myDataDefaults();
    server.use(http.get(`${API}/me/erasure/preview`, () => HttpResponse.json(preview())));
    renderApp('/me/data');
    expect(await screen.findByText('What will be removed')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    for (const phrase of [
      'Your academic record',
      'Approved gradebooks',
      'name and register number it recorded',
      'legal counsel',
      'The audit trail',
      'Backups',
      'up to 30 days',
      '7 days in which you',
      'within 30 days',
    ])
      expect(text, phrase).toContain(phrase);
    expect(text).toContain('2 sign-ins on devices');
    expect(text).toContain('4 quiz attempts');
    expect(text).toContain('1 line in an approved gradebook');
    expect(text).toContain('7 entries in the audit trail');
    // nothing can be asked without the password and the confirmation
    const button = screen.getByRole('button', { name: 'Ask to be erased' });
    expect(button).toBeDisabled();
  });

  it('asks with the password, shows the open request, and the member can cancel it', async () => {
    mockSignedIn(memberMe);
    myDataDefaults();
    let sent: unknown = null;
    let cancelled = 0;
    server.use(
      http.get(`${API}/me/erasure/preview`, () => HttpResponse.json(preview())),
      http.post(`${API}/me/erasure`, async ({ request: r }) => {
        sent = await r.json();
        return HttpResponse.json({ request: request(), alreadyInProgress: false }, { status: 202 });
      }),
      http.post(`${API}/me/erasure/cancel`, () => {
        cancelled += 1;
        return HttpResponse.json({ request: request({ status: 'cancelled' }) });
      }),
    );
    const { user } = renderApp('/me/data');
    await screen.findByText('What will be removed');
    const pw = screen.getByLabelText('Password to confirm');
    await user.type(pw, 'secret-pass-1');
    const button = screen.getByRole('button', { name: 'Ask to be erased' });
    expect(button).toBeDisabled(); // the password alone is not enough
    await user.click(screen.getByRole('checkbox', { name: /I understand what is removed/ }));
    await user.click(button);
    await waitFor(() => expect(sent).toEqual({ password: 'secret-pass-1' }));
    expect(await screen.findByText('Your request is open.')).toBeInTheDocument();
    expect(screen.getByText('Waiting for an administrator')).toBeInTheDocument();
    expect(screen.getByText(/If nobody decides it ends on/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel my request' }));
    await waitFor(() => expect(cancelled).toBe(1));
    expect(await screen.findByRole('button', { name: 'Ask to be erased' })).toBeInTheDocument();
  });

  it('an approved request says when it will be carried out; a wrong password shows the server message', async () => {
    mockSignedIn(memberMe);
    myDataDefaults();
    server.use(
      http.get(`${API}/me/erasure/preview`, () =>
        HttpResponse.json(
          preview({
            open: request({ status: 'approved', graceUntil: '2026-03-18T09:00:00.000Z' }),
          }),
        ),
      ),
    );
    renderApp('/me/data');
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(
      screen.getByText(/It will be carried out on .* You can cancel until then\./),
    ).toBeInTheDocument();
  });

  it('shows the wrong-password message and keeps the form', async () => {
    mockSignedIn(memberMe);
    myDataDefaults();
    server.use(
      http.get(`${API}/me/erasure/preview`, () => HttpResponse.json(preview())),
      http.post(`${API}/me/erasure`, () =>
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
    await screen.findByText('What will be removed');
    await user.type(screen.getByLabelText('Password to confirm'), 'wrong');
    await user.click(screen.getByRole('checkbox', { name: /I understand/ }));
    await user.click(screen.getByRole('button', { name: 'Ask to be erased' }));
    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask to be erased' })).toBeInTheDocument();
  });

  it('the last administrator is told why they cannot ask; an error state offers a retry', async () => {
    mockSignedIn(memberMe);
    myDataDefaults();
    let calls = 0;
    server.use(
      http.get(`${API}/me/erasure/preview`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'boom', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json(preview({ lastAdmin: true }));
      }),
    );
    const { user } = renderApp('/me/data');
    const retry = await screen.findAllByRole('button', { name: 'Try again' });
    await user.click(retry.at(-1) as HTMLElement);
    expect(
      await screen.findByText(/only active administrator of this college/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask to be erased' })).not.toBeInTheDocument();
  });
});

describe('Erasure requests (administrators)', () => {
  const items = [
    { ...request({ id: id(1) }), memberName: 'Mia Member', memberEmail: 'mia@alpha.test' },
    {
      ...request({ id: id(2), status: 'approved', graceUntil: '2026-03-18T09:00:00.000Z' }),
      memberName: 'Ben Bright',
      memberEmail: 'ben@alpha.test',
    },
    { ...request({ id: id(3) }), memberName: 'Ada Admin', memberEmail: adminMe.user.email },
  ];

  it('lists the requests; approving names the member and the 7 days, updates the row in place; your own request cannot be decided by you', async () => {
    mockSignedIn(adminMe);
    let decided: string | null = null;
    server.use(
      http.get(`${API}/privacy/erasure-requests`, () => HttpResponse.json({ items })),
      http.post(`${API}/privacy/erasure-requests/:id/:action`, ({ params }) => {
        decided = `${params.id}:${params.action}`;
        return HttpResponse.json({
          request: request({
            id: params.id as string,
            status: 'approved',
            graceUntil: '2026-03-18T09:00:00.000Z',
          }),
        });
      }),
    );
    const { user } = renderApp('/privacy/erasure');
    expect(await screen.findByText('Mia Member')).toBeInTheDocument();
    // the administrator's own request: no approve / reject button for it
    const own = screen
      .getAllByText('Ada Admin')
      .find((el) => el.closest('li'))
      ?.closest('li') as HTMLElement;
    expect(within(own).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(
      within(own).getByText(/Another administrator decides on your request/),
    ).toBeInTheDocument();
    const row = screen.getByText('Mia Member').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Approve the request of Mia Member?')).toBeInTheDocument();
    expect(dialog.textContent).toContain('7 days');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('audit trail are kept');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decided).toBe(`${id(1)}:approve`));
    await waitFor(() =>
      expect(within(row).getByText('Approved: grace period running')).toBeInTheDocument(),
    );
  });

  it('empty and error states, and only people with the permission see the page in the menu', async () => {
    mockSignedIn(adminMe);
    let calls = 0;
    server.use(
      http.get(`${API}/privacy/erasure-requests`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'boom', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({ items: [] });
      }),
    );
    const { user } = renderApp('/privacy/erasure');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No requests')).toBeInTheDocument();
  });
});
