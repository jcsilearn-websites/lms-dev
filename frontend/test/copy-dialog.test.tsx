import type { CopyContentRequest } from '@lms/backend/contracts';
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { Providers } from '../src/app/providers';
import { CopyDialog } from '../src/features/courses/CopyDialog';
import { API, errorBody, server } from './server';

// One request key per intended copy: a retry after a lost or failed answer sends the SAME key, so the server copies once.

const id = (n: number) => `00000000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
const TARGET = id(1);
const source = (n: number, title: string) => ({
  id: id(n),
  title,
  termName: 'Term',
  label: '',
  myParticipation: 'instructor',
});

describe('copy content from another course', () => {
  it('a retry sends the same key; choosing something else sends a new one', async () => {
    const sent: CopyContentRequest[] = [];
    server.use(
      http.get(`${API}/me/courses`, () =>
        HttpResponse.json({ items: [source(2, 'Alpha'), source(3, 'Beta')], nextCursor: null }),
      ),
      http.get(`${API}/offerings/:id/copy-preview`, () =>
        HttpResponse.json({
          source: { id: id(2), title: 'Alpha', termName: 'Term', termStart: '2026-01-01' },
          target: { id: TARGET, title: 'Mine', termName: 'Term', termStart: '2026-01-01' },
          defaultShiftDays: 0,
          sameCourse: true,
          items: [],
        }),
      ),
      http.post(`${API}/offerings/:id/copy`, async ({ request }) => {
        sent.push((await request.json()) as CopyContentRequest);
        return HttpResponse.json(errorBody('internal_error', 'Internal server error'), {
          status: 500,
        });
      }),
    );
    const user = userEvent.setup();
    render(
      <Providers client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CopyDialog offeringId={TARGET} onClose={() => {}} />
      </Providers>,
    );
    const from = await screen.findByLabelText('Copy from');
    const copy = screen.getByRole('button', { name: 'Copy content' });
    await user.selectOptions(from, id(2));
    await user.click(copy);
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]?.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]?.requestKey).toBe(sent[0]?.requestKey);

    await user.selectOptions(from, id(3));
    await waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]?.sourceOfferingId).toBe(id(3));
    expect(sent[2]?.requestKey).not.toBe(sent[0]?.requestKey);
  });
});
