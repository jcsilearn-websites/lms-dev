import type {
  ClassPage,
  ClassRow,
  ItemDto,
  LearnerDrilldown,
  MyProgress,
} from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { item, moduleOf, OFFERING_ID, offering, outline, STAMP } from './courses-fixtures';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// Learning progress screens (step 8): My courses, the course page, the item page (Mark as done), the class view, the
// builder's archive explanation. Every body is typed with the contracts.

const base = `${API}/offerings/${OFFERING_ID}`;
const page = <T,>(items: T[]) => HttpResponse.json({ items, nextCursor: null });

const mineOf = (over: Partial<MyProgress> = {}): MyProgress => ({
  participant: true,
  completedRequired: 0,
  totalRequired: 0,
  percent: null,
  modules: [],
  items: [],
  resume: null,
  ...over,
});

function mockOffering(o = offering(), out = outline([])) {
  server.use(
    http.get(base, () => HttpResponse.json(o)),
    http.get(`${base}/outline`, () => HttpResponse.json(out)),
  );
}

describe('My courses', () => {
  it('shows a progress bar on each course and "Continue where you left off"', async () => {
    mockSignedIn(memberMe);
    const lecture = item(1, { title: 'Lecture 2' });
    server.use(
      http.get(`${API}/me/courses`, () => page([offering({ id: OFFERING_ID, title: 'Algebra' })])),
      http.get(`${API}/me/progress`, () =>
        HttpResponse.json({
          offerings: [
            { offeringId: OFFERING_ID, completedRequired: 3, totalRequired: 12, percent: 25 },
          ],
          resume: {
            offeringId: OFFERING_ID,
            offeringTitle: 'Algebra',
            itemId: lecture.id,
            itemTitle: 'Lecture 2',
            kind: 'video',
            positionSeconds: 125,
            lastActivityAt: STAMP,
          },
        }),
      ),
    );
    renderApp('/');
    const bar = await screen.findByRole('progressbar', { name: 'Progress in Algebra' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('25% complete')).toBeInTheDocument();
    expect(screen.getByText('3 of 12')).toBeInTheDocument();
    const resume = await screen.findByRole('link', { name: /Lecture 2/ });
    expect(resume).toHaveAttribute('href', `/offerings/${OFFERING_ID}/items/${lecture.id}`);
    expect(resume).toHaveTextContent('Algebra · resumes at 2:05');
    expect(
      screen.getByRole('heading', { name: 'Continue where you left off' }),
    ).toBeInTheDocument();
  });

  it('shows no bar for a course without required items, and no resume card when there is nothing to resume', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/me/courses`, () => page([offering({ id: OFFERING_ID, title: 'Algebra' })])),
      http.get(`${API}/me/progress`, () =>
        HttpResponse.json({
          offerings: [
            { offeringId: OFFERING_ID, completedRequired: 0, totalRequired: 0, percent: null },
          ],
          resume: null,
        }),
      ),
    );
    renderApp('/');
    await screen.findByRole('link', { name: /Algebra/ });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Continue where you left off')).toBeNull();
  });

  it('still lists the courses when the progress cannot be loaded', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/me/courses`, () => page([offering({ id: OFFERING_ID, title: 'Algebra' })])),
      http.get(`${API}/me/progress`, () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'x', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );
    renderApp('/');
    expect(await screen.findByRole('link', { name: /Algebra/ })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('the course page', () => {
  const read = item(1, { title: 'Read this' });
  const extra = item(2, { title: 'Extra reading', required: false });
  const m1 = moduleOf(1, [read, extra]);

  it('shows a learner their course and module percentages and the status of every item', async () => {
    mockSignedIn(memberMe);
    mockOffering(offering({ title: 'Programming' }), outline([m1]));
    server.use(
      http.get(`${base}/progress`, () =>
        HttpResponse.json(
          mineOf({
            completedRequired: 1,
            totalRequired: 2,
            percent: 50,
            modules: [{ moduleId: m1.id, completedRequired: 1, totalRequired: 2, percent: 50 }],
            items: [
              {
                itemId: read.id,
                moduleId: m1.id,
                status: 'completed',
                required: true,
                watchedPercent: null,
                positionSeconds: null,
              },
              {
                itemId: extra.id,
                moduleId: m1.id,
                status: 'not_started',
                required: false,
                watchedPercent: null,
                positionSeconds: null,
              },
            ],
          }),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}`);
    const bar = await screen.findByRole('progressbar', { name: 'Your progress in Programming' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('1 of 2 required items')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Module 1/ })).toHaveTextContent('50% complete');
    const lineOf = (name: RegExp) =>
      within(screen.getByRole('link', { name }).closest('li') as HTMLElement);
    expect(lineOf(/Read this/).getByText('Completed')).toBeInTheDocument();
    expect(lineOf(/Extra reading/).getByText('Not started')).toBeInTheDocument();
    expect(lineOf(/Extra reading/).getByText('Optional')).toBeInTheDocument();
  });

  it('shows an instructor no progress bar but a link to the class progress; a learner has no such link', async () => {
    mockSignedIn(memberMe);
    mockOffering(offering({ myParticipation: 'instructor' }), outline([m1]));
    renderApp(`/offerings/${OFFERING_ID}`);
    const link = await screen.findByRole('link', { name: 'Class progress' });
    expect(link).toHaveAttribute('href', `/offerings/${OFFERING_ID}/progress`);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a learner sees no link to the class progress', async () => {
    mockSignedIn(memberMe);
    mockOffering(offering(), outline([m1]));
    server.use(http.get(`${base}/progress`, () => HttpResponse.json(mineOf())));
    renderApp(`/offerings/${OFFERING_ID}`);
    await screen.findByRole('heading', { name: /Module 1/ });
    expect(screen.queryByRole('link', { name: 'Class progress' })).toBeNull();
  });
});

describe('the item page: Mark as done', () => {
  const ITEM = 'a1000000-0000-7000-8000-000000000001';
  const itemDto = (over: Partial<ItemDto> = {}): ItemDto => ({
    id: ITEM,
    moduleId: 'b1000000-0000-7000-8000-000000000001',
    kind: 'text',
    title: 'Reading 1',
    published: true,
    availableFrom: null,
    locked: false,
    url: null,
    file: null,
    video: null,
    body: null,
    required: true,
    completion: 'manual',
    updatedAt: STAMP,
    ...over,
  });
  const statusItem = (status: MyProgress['items'][number]['status']): MyProgress =>
    mineOf({
      items: [
        {
          itemId: ITEM,
          moduleId: 'b1000000-0000-7000-8000-000000000001',
          status,
          required: true,
          watchedPercent: null,
          positionSeconds: null,
        },
      ],
    });

  it('marks a text item as done and undoes it, with the status in words', async () => {
    mockSignedIn(memberMe);
    let status: 'not_started' | 'completed' = 'not_started';
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(itemDto())),
      http.get(`${base}/progress`, () => HttpResponse.json(statusItem(status))),
      http.post(`${base}/items/${ITEM}/progress/complete`, () => {
        status = 'completed';
        return HttpResponse.json({ status });
      }),
      http.delete(`${base}/items/${ITEM}/progress/complete`, () => {
        status = 'not_started';
        return HttpResponse.json({ status });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText('Not started')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Mark as done' }));
    expect(await screen.findByText('You marked this as done.')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Marked as done')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as not done' }));
    expect(await screen.findByRole('button', { name: 'Mark as done' })).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
  });

  it('shows the server’s refusal in a toast (and keeps the button)', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(itemDto())),
      http.get(`${base}/progress`, () => HttpResponse.json(statusItem('not_started'))),
      http.post(`${base}/items/${ITEM}/progress/complete`, () =>
        HttpResponse.json(
          { error: { code: 'item_not_found', message: 'Item not found', requestId: 'r' } },
          { status: 404 },
        ),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    await user.click(await screen.findByRole('button', { name: 'Mark as done' }));
    expect(await screen.findByText('Item not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as done' })).toBeInTheDocument();
  });

  it('opening an item that completes on view tells the server once', async () => {
    mockSignedIn(memberMe);
    const viewed = vi.fn();
    let status: 'not_started' | 'completed' = 'not_started';
    server.use(
      http.get(`${base}/items/${ITEM}`, () =>
        HttpResponse.json(
          itemDto({ kind: 'link', url: 'https://example.org/r', completion: 'on_view' }),
        ),
      ),
      http.get(`${base}/progress`, () => HttpResponse.json(statusItem(status))),
      http.post(`${base}/items/${ITEM}/progress/viewed`, () => {
        viewed();
        status = 'completed';
        return HttpResponse.json({ status });
      }),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(viewed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Mark as done' })).toBeNull();
  });

  it('an instructor looking at an item gets no status, no button and no request that records anything', async () => {
    mockSignedIn(memberMe);
    const recorded = vi.fn();
    server.use(
      http.get(`${base}/items/${ITEM}`, () =>
        HttpResponse.json(
          itemDto({ kind: 'link', url: 'https://example.org/r', completion: 'on_view' }),
        ),
      ),
      http.post(`${base}/items/${ITEM}/progress/viewed`, () => {
        recorded();
        return HttpResponse.json({ status: 'completed' });
      }),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    await screen.findByRole('heading', { name: 'Reading 1' });
    await waitFor(() => expect(screen.queryByText('Not started')).toBeNull());
    expect(screen.queryByRole('button', { name: /Mark as/ })).toBeNull();
    expect(recorded).not.toHaveBeenCalled();
  });
});

describe('the class progress page', () => {
  const M1 = 'b1000000-0000-7000-8000-000000000001';
  const row = (n: number, over: Partial<ClassRow> = {}): ClassRow => ({
    participantId: `c${n}000000-0000-7000-8000-000000000001`,
    userId: `d${n}000000-0000-7000-8000-000000000001`,
    displayName: `Learner ${n}`,
    email: `l${n}@alpha.test`,
    sectionName: 'CS-A',
    removed: false,
    completedRequired: n,
    totalRequired: 4,
    percent: n * 25,
    status: 'in_progress',
    lastActivityAt: STAMP,
    modules: [{ moduleId: M1, percent: n * 25 }],
    ...over,
  });
  const classPage = (items: ClassRow[], over: Partial<ClassPage> = {}): ClassPage => ({
    modules: [{ id: M1, title: 'Week 1' }],
    items,
    nextCursor: null,
    total: items.length,
    ...over,
  });

  function mockClass(handler: (url: URL) => ClassPage) {
    mockSignedIn(memberMe);
    mockOffering(offering({ myParticipation: 'instructor' }));
    server.use(
      http.get(`${base}/sections`, () =>
        HttpResponse.json({
          items: [
            {
              sectionId: 'e1000000-0000-7000-8000-000000000001',
              sectionCode: 'A',
              batchId: 'e2000000-0000-7000-8000-000000000001',
              batchLabel: '2026',
              programCode: 'BCA',
            },
          ],
        }),
      ),
      http.get(`${base}/progress/class`, ({ request }) =>
        HttpResponse.json(handler(new URL(request.url))),
      ),
    );
  }

  it('lists learners with their percentages per module, a status in words, and a name for the table', async () => {
    mockClass(() =>
      classPage([row(1), row(3, { status: 'behind' }), row(4, { status: 'completed' })]),
    );
    renderApp(`/offerings/${OFFERING_ID}/progress`);
    const table = await screen.findByRole('table', { name: 'Class progress' });
    expect(within(table).getByRole('columnheader', { name: 'Week 1' })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4); // the header and three learners
    expect(within(rows[2] as HTMLElement).getByText('Behind')).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByText('Completed')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('25%')).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByRole('progressbar', { name: 'Progress of Learner 1' }),
    ).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('3 learners')).toBeInTheDocument();
  });

  it('filters and sorts on the server, and "Load more" continues with the cursor', async () => {
    const urls: URL[] = [];
    mockClass((url) => {
      urls.push(url);
      return url.searchParams.get('after')
        ? classPage([row(2)], { total: 2 })
        : classPage([row(1)], { total: 2, nextCursor: 'CURSOR1' });
    });
    const { user } = renderApp(`/offerings/${OFFERING_ID}/progress`);
    await screen.findByRole('table', { name: 'Class progress' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Learner 2');
    expect(screen.getByText('Learner 1')).toBeInTheDocument();
    expect(urls.at(-1)?.searchParams.get('after')).toBe('CURSOR1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Status'), 'behind');
    await waitFor(() => expect(urls.at(-1)?.searchParams.get('status')).toBe('behind'));
    expect(urls.at(-1)?.searchParams.get('after')).toBeNull(); // a new filter starts again
    await user.selectOptions(screen.getByLabelText('Sort by'), 'percent');
    await user.selectOptions(screen.getByLabelText('Order'), 'desc');
    await waitFor(() => {
      expect(urls.at(-1)?.searchParams.get('sort')).toBe('percent');
      expect(urls.at(-1)?.searchParams.get('dir')).toBe('desc');
    });
    await user.selectOptions(
      screen.getByLabelText('Section'),
      'e1000000-0000-7000-8000-000000000001',
    );
    await waitFor(() =>
      expect(urls.at(-1)?.searchParams.get('section')).toBe('e1000000-0000-7000-8000-000000000001'),
    );
  });

  it('shows removed learners as read-only history when asked', async () => {
    const urls: URL[] = [];
    mockClass((url) => {
      urls.push(url);
      return url.searchParams.get('learners') === 'removed'
        ? classPage([row(1, { removed: true })])
        : classPage([row(2)]);
    });
    const { user } = renderApp(`/offerings/${OFFERING_ID}/progress`);
    await screen.findByText('Learner 2');
    await user.selectOptions(screen.getByLabelText('Learners'), 'removed');
    expect(await screen.findByText('Learner 1')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.getByText(/removed: read-only history/)).toBeInTheDocument();
  });

  it('has an empty state and an error state with a retry', async () => {
    let calls = 0;
    mockSignedIn(memberMe);
    mockOffering(offering({ myParticipation: 'instructor' }));
    server.use(
      http.get(`${base}/sections`, () => HttpResponse.json({ items: [] })),
      http.get(`${base}/progress/class`, () => {
        calls++;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'x', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json(classPage([]));
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/progress`);
    expect(await screen.findByText('Could not load the class progress')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No learners to show')).toBeInTheDocument();
  });

  it('opens one learner item by item, with flagged heartbeats', async () => {
    mockClass(() => classPage([row(1)]));
    const detail: LearnerDrilldown = {
      learner: {
        participantId: row(1).participantId,
        displayName: 'Learner 1',
        email: 'l1@alpha.test',
        removed: false,
        completedRequired: 1,
        totalRequired: 4,
        percent: 25,
      },
      items: [
        {
          itemId: 'a1000000-0000-7000-8000-000000000001',
          moduleId: M1,
          moduleTitle: 'Week 1',
          title: 'Lecture 1',
          kind: 'video',
          required: true,
          status: 'in_progress',
          watchedPercent: 40,
          watchedSeconds: 240,
          durationSeconds: 600,
          completedAt: null,
          completedHow: null,
          lastActivityAt: STAMP,
          flagged: 2,
        },
      ],
    };
    server.use(
      http.get(`${base}/progress/learners/${row(1).participantId}`, () =>
        HttpResponse.json(detail),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/progress`);
    await user.click(await screen.findByRole('button', { name: 'Details of Learner 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Lecture 1')).toBeInTheDocument();
    expect(within(dialog).getByText(/watched 40%/)).toBeInTheDocument();
    expect(within(dialog).getByText('2 flagged heartbeats')).toBeInTheDocument();
  });

  it('exports the CSV with the filters that are on screen', async () => {
    mockClass(() => classPage([row(1)]));
    let asked: URL | null = null;
    server.use(
      http.get(`${base}/progress/class.csv`, ({ request }) => {
        asked = new URL(request.url);
        return new HttpResponse('Name,Progress\r\nLearner 1,25\r\n', {
          headers: { 'content-type': 'text/csv' },
        });
      }),
    );
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { user } = renderApp(`/offerings/${OFFERING_ID}/progress`);
    await screen.findByRole('table', { name: 'Class progress' });
    await user.selectOptions(screen.getByLabelText('Status'), 'behind');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(asked).not.toBeNull());
    expect((asked as URL | null)?.searchParams.get('status')).toBe('behind');
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('the instructor edits the video completion share and the behind days, with the server’s limits', async () => {
    mockClass(() => classPage([row(1)]));
    let sent: unknown;
    server.use(
      http.patch(base, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          offering({ myParticipation: 'instructor', completionThreshold: 80, behindAfterDays: 14 }),
        );
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/progress`);
    const threshold = await screen.findByLabelText('Video completes at (% watched)');
    expect(threshold).toHaveValue(90);
    expect(screen.getByLabelText('Behind after (days)')).toHaveValue(7);
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled(); // nothing changed yet
    await user.clear(threshold);
    await user.type(threshold, '40');
    expect(await screen.findByText('Enter a whole number from 50 to 100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(sent).toBeUndefined(); // refused on the screen, nothing was sent
    await user.clear(threshold);
    await user.type(threshold, '80');
    const days = screen.getByLabelText('Behind after (days)');
    await user.clear(days);
    await user.type(days, '14');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent).toEqual({ completionThreshold: 80, behindAfterDays: 14 }));
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
  });
});

describe('the builder: archive instead of delete', () => {
  const first = item(1, { title: 'First', hasProgress: true });
  const third = item(3, { title: 'Third' });
  const m1 = moduleOf(1, [first, item(2, { title: 'Second' }), third], { hasProgress: true });

  function mockBuilder() {
    mockSignedIn(memberMe);
    mockOffering(offering({ myParticipation: 'instructor', status: 'draft' }), outline([m1], true));
  }

  it('says an item with learner progress will be archived, and the confirm button names it', async () => {
    mockBuilder();
    let deleted = 0;
    server.use(
      http.delete(`${base}/items/${first.id}`, () => {
        deleted++;
        return HttpResponse.json({ status: 'archived' });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await user.click(await screen.findByRole('button', { name: 'Delete First' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Archive “First”?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('This item has learner progress, so it will be archived');
    await user.click(within(dialog).getByRole('button', { name: 'Archive “First”' }));
    expect(
      await screen.findByText('Archived “First”. Its learner progress is kept.'),
    ).toBeInTheDocument();
    expect(deleted).toBe(1);
    expect(screen.queryByRole('button', { name: 'Edit First' })).toBeNull(); // gone from the builder
  });

  it('an item without progress is still deleted for good, with the usual warning', async () => {
    mockBuilder();
    server.use(
      http.delete(`${base}/items/${third.id}`, () => HttpResponse.json({ status: 'deleted' })),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await user.click(await screen.findByRole('button', { name: 'Delete Third' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete “Third”?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('This cannot be undone.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete “Third”' }));
    expect(await screen.findByText('Deleted “Third”.')).toBeInTheDocument();
  });

  it('a module with progress anywhere inside is archived too', async () => {
    mockBuilder();
    server.use(
      http.delete(`${base}/modules/${m1.id}`, () => HttpResponse.json({ status: 'archived' })),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await user.click(await screen.findByRole('button', { name: 'Delete module Module 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Archive module “Module 1”?' }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'Learners have progress in this module, so it will be archived',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Archive “Module 1”' }));
    expect(
      await screen.findByText('Archived module “Module 1”. Its learner progress is kept.'),
    ).toBeInTheDocument();
  });
});
