import type { ImportDto } from '@lms/backend/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from './render';
import { API, errorBody, importDto, mockSignedIn, server } from './server';

const ID = importDto().id;
const badRows = {
  items: [
    {
      rowNumber: 3,
      status: 'invalid',
      cells: { email: 'bad-email', full_name: 'Bob' },
      errors: [{ column: 'email', message: 'is not a valid email address' }],
      result: null,
    },
  ],
  nextCursor: null,
};

describe('upload step', () => {
  it('refuses a file that is not a CSV before sending anything', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/imports`, () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    const { user } = renderApp('/imports');
    const input = (await screen.findByLabelText('CSV file')) as HTMLInputElement;
    await user.upload(input, new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a .csv file.');
    expect(screen.getByRole('button', { name: 'Upload and check' })).toBeDisabled();
  });

  it('uploads as multipart with the chosen kind and moves on to the review', async () => {
    mockSignedIn();
    let kind: string | null = null;
    let contentType: string | null = null;
    server.use(
      http.get(`${API}/imports`, () => HttpResponse.json({ items: [], nextCursor: null })),
      http.post(`${API}/imports`, ({ request }) => {
        kind = new URL(request.url).searchParams.get('kind');
        contentType = request.headers.get('content-type');
        return HttpResponse.json(importDto(), { status: 201 });
      }),
      http.get(`${API}/imports/${ID}/rows`, () => HttpResponse.json(badRows)),
    );
    const { user, router } = renderApp('/imports');
    await user.click(await screen.findByLabelText('faculty'));
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File(['email,full_name\n'], 'f.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: 'Upload and check' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/imports/${ID}`));
    expect(kind).toBe('faculty');
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('explains "another import is running" in plain words', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/imports`, () => HttpResponse.json({ items: [], nextCursor: null })),
      http.post(`${API}/imports`, () =>
        HttpResponse.json(errorBody('import_in_progress', 'An import is already running'), {
          status: 409,
        }),
      ),
    );
    const { user } = renderApp('/imports');
    await user.upload(
      await screen.findByLabelText('CSV file'),
      new File(['x'], 's.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: 'Upload and check' }));
    expect(await screen.findByText(/Another import is still running/)).toBeInTheDocument();
  });
});

describe('review and confirm', () => {
  function reviewHandlers(
    onConfirm: (body: unknown) => void = () => undefined,
    over: Partial<ImportDto> = {},
  ) {
    mockSignedIn();
    server.use(
      http.get(`${API}/imports/${ID}`, () => HttpResponse.json(importDto(over))),
      http.get(`${API}/imports/${ID}/rows`, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        return HttpResponse.json(
          status === 'invalid' ? badRows : { items: [...badRows.items], nextCursor: null },
        );
      }),
      http.post(`${API}/imports/${ID}/confirm`, async ({ request }) => {
        const body = await request.json();
        onConfirm(body);
        return HttpResponse.json(importDto({ status: 'queued', skipInvalid: true }));
      }),
    );
  }

  it('shows the problem rows with their messages and blocks the import until "skip invalid" is ticked', async () => {
    let confirmed: unknown;
    reviewHandlers((b) => {
      confirmed = b;
    });
    const { user } = renderApp(`/imports/${ID}`);
    expect((await screen.findAllByText('is not a valid email address')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/bad-email - Bob/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 row has problems and will not be imported/)).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Import 2 people' });
    expect(confirmButton).toBeDisabled();
    await user.click(screen.getByLabelText(/Skip the 1 rows with problems/));
    await user.click(screen.getByLabelText(/Update existing members/));
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    await waitFor(() => expect(confirmed).toEqual({ updateExisting: true, skipInvalid: true }));
  });

  it('downloads the error report', async () => {
    reviewHandlers();
    let downloaded = false;
    server.use(
      http.get(`${API}/imports/${ID}/errors.csv`, () => {
        downloaded = true;
        return new HttpResponse('row,column,message\n3,email,bad\n', {
          headers: { 'content-type': 'text/csv' },
        });
      }),
    );
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { user } = renderApp(`/imports/${ID}`);
    await user.click(
      await screen.findByRole('button', { name: 'Download the error report (CSV)' }),
    );
    await waitFor(() => expect(downloaded).toBe(true));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('cancelling asks first and names the file', async () => {
    reviewHandlers();
    let cancelled = false;
    server.use(
      http.post(`${API}/imports/${ID}/cancel`, () => {
        cancelled = true;
        return HttpResponse.json(importDto({ status: 'cancelled' }));
      }),
    );
    const { user } = renderApp(`/imports/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Cancel this import' }));
    expect(cancelled).toBe(false);
    const dialog = await screen.findByRole('dialog', {
      name: 'Cancel the import of students.csv?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel students.csv' }));
    await waitFor(() => expect(cancelled).toBe(true));
    expect(await screen.findByText(/This import was cancelled/)).toBeInTheDocument();
  });

  it('an import with no problems needs no extra tick', async () => {
    reviewHandlers(undefined, {
      counts: { ...importDto().counts, total: 2, valid: 2, invalid: 0 },
    });
    renderApp(`/imports/${ID}`);
    expect(await screen.findByRole('button', { name: 'Import 2 people' })).toBeEnabled();
    expect(screen.queryByLabelText(/Skip the/)).not.toBeInTheDocument();
  });
});

describe('live progress', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const running = (processed: number, status: ImportDto['status'] = 'processing') =>
    importDto({
      status,
      counts: {
        ...importDto().counts,
        total: 10,
        valid: 10,
        invalid: 0,
        processed,
        created: processed,
      },
    });

  it('polls while it runs, backs off, and stops by itself when it is finished', async () => {
    mockSignedIn();
    const states = [running(0, 'queued'), running(3), running(7), running(10, 'completed')];
    states[3] = importDto({
      status: 'completed',
      counts: { ...running(10).counts, processed: 10, created: 10 },
    });
    let gets = 0;
    server.use(
      http.get(`${API}/imports/${ID}`, () =>
        HttpResponse.json(states[Math.min(gets++, states.length - 1)]),
      ),
    );
    renderApp(`/imports/${ID}`);

    expect(await screen.findByRole('progressbar', { name: 'Import progress' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30'),
    );
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70'),
    );
    await act(() => vi.advanceTimersByTimeAsync(2100));

    // finished: the summary replaces the progress bar
    expect(await screen.findByText('New members')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    const requestsWhenDone = gets;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(gets).toBe(requestsWhenDone); // a terminal status ends the polling
  });

  it('does not poll while the tab is hidden', async () => {
    mockSignedIn();
    let gets = 0;
    server.use(
      http.get(`${API}/imports/${ID}`, () => {
        gets += 1;
        return HttpResponse.json(running(1));
      }),
    );
    renderApp(`/imports/${ID}`);
    await screen.findByRole('progressbar');
    const before = gets;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(gets).toBe(before);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(gets).toBeGreaterThan(before));
  });
});
