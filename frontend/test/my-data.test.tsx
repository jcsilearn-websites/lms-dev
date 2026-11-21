import type { DataExport } from '@lms/backend/contracts';
import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// Step 14b: "My data". The password is asked again; a wrong one shows the server's message and keeps the form; the list follows the
// states of an export; the download asks for a fresh signed link; an expired export has no button.

const id = (n: number) => `00000000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
const exp = (over: Partial<DataExport> & Pick<DataExport, 'id' | 'status'>): DataExport => ({
  requestedAt: '2026-03-10T09:00:00.000Z',
  readyAt: null,
  expiresAt: null,
  sizeBytes: null,
  counts: null,
  ...over,
});

describe('My data', () => {
  it('shows a skeleton, then an empty state, and asks for the password before preparing anything', async () => {
    mockSignedIn(memberMe);
    let asked: unknown = null;
    const made: DataExport[] = [];
    server.use(
      http.get(`${API}/me/data-exports`, () => HttpResponse.json({ items: made })),
      http.post(`${API}/me/data-exports`, async ({ request }) => {
        asked = await request.json();
        made.push(exp({ id: id(1), status: 'queued' }));
        return HttpResponse.json(
          { export: exp({ id: id(1), status: 'queued' }), alreadyInProgress: false },
          { status: 202 },
        );
      }),
    );
    const { user } = renderApp('/me/data');
    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Prepare my data' });
    expect(button).toBeDisabled(); // nothing without a password
    await user.type(screen.getByLabelText('Your password'), 'secret-pass-1');
    await user.click(button);
    await waitFor(() => expect(asked).toEqual({ password: 'secret-pass-1' }));
    // the new request is in the list at once (cache patched), the field is cleared
    expect(await screen.findAllByText('Waiting to be prepared')).not.toHaveLength(0);
    expect(screen.getByLabelText('Your password')).toHaveValue('');
  });

  it('a wrong password shows the server message and keeps nothing in the list', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/me/data-exports`, () => HttpResponse.json({ items: [] })),
      http.post(`${API}/me/data-exports`, () =>
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
    await screen.findByText('No requests yet');
    await user.type(screen.getByLabelText('Your password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Prepare my data' }));
    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
    expect(screen.getByText('No requests yet')).toBeInTheDocument();
  });

  it('lists each state in words; only a ready archive has a Download button, which asks for a fresh link', async () => {
    mockSignedIn(memberMe);
    let linkAsked = 0;
    server.use(
      http.get(`${API}/me/data-exports`, () =>
        HttpResponse.json({
          items: [
            exp({
              id: id(1),
              status: 'ready',
              readyAt: '2026-03-10T09:05:00.000Z',
              expiresAt: '2026-03-17T09:05:00.000Z',
              sizeBytes: 20480,
            }),
            exp({ id: id(2), status: 'expired' }),
            exp({ id: id(3), status: 'failed' }),
          ],
        }),
      ),
      http.get(`${API}/me/data-exports/${id(1)}/download`, () => {
        linkAsked += 1;
        // not followed in jsdom: the page assigns window.location
        return HttpResponse.json({
          url: '/api/storage/download/x',
          expiresAt: '2026-03-10T09:10:00.000Z',
          fileName: 'my-data.zip',
        });
      }),
    );
    const { user } = renderApp('/me/data');
    expect(await screen.findByText('Ready to download')).toBeInTheDocument();
    expect(screen.getAllByText('Expired and deleted')).not.toHaveLength(0);
    expect(screen.getAllByText('Could not be prepared')).not.toHaveLength(0);
    expect(screen.getByText(/20 KB, available until/)).toBeInTheDocument();
    const downloads = screen.getAllByRole('button', { name: 'Download' });
    expect(downloads).toHaveLength(1);
    await user.click(downloads[0] as HTMLElement);
    await waitFor(() => expect(linkAsked).toBe(1));
  });

  it('shows an error state with a retry when the list cannot be loaded', async () => {
    mockSignedIn(memberMe);
    let calls = 0;
    server.use(
      http.get(`${API}/me/data-exports`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'boom', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({ items: [] });
      }),
    );
    const { user } = renderApp('/me/data');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
  });
});
