import type { OutlineDto } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  course,
  item,
  moduleOf,
  OFFERING_ID,
  offering,
  outline,
  participant,
} from './courses-fixtures';
import { renderApp } from './render';
import { API, adminMe, memberMe, mockSignedIn, server } from './server';

// The course screens: My courses, the outline (learner and instructor view), the builder, people, the catalog.

const page = <T,>(items: T[]) => HttpResponse.json({ items, nextCursor: null });
const base = `${API}/offerings/${OFFERING_ID}`;

function mockOffering(o = offering(), out: OutlineDto = outline([])) {
  server.use(
    http.get(base, () => HttpResponse.json(o)),
    http.get(`${base}/outline`, () => HttpResponse.json(out)),
  );
}

describe('My courses (home)', () => {
  it('lists the courses I take part in with my role and the draft flag', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/me/courses`, () =>
        page([
          offering({
            id: '11000000-0000-7000-8000-000000000001',
            title: 'Algebra',
            myParticipation: 'learner',
          }),
          offering({
            id: '12000000-0000-7000-8000-000000000001',
            title: 'Databases',
            myParticipation: 'instructor',
            status: 'draft',
          }),
        ]),
      ),
    );
    renderApp('/');
    const algebra = await screen.findByRole('link', { name: /Algebra/ });
    const region = screen.getByRole('region', { name: 'My courses' });
    expect(algebra).toHaveAttribute('href', '/offerings/11000000-0000-7000-8000-000000000001');
    expect(within(region).getByText('Learner')).toBeInTheDocument();
    expect(within(region).getByText('Instructor')).toBeInTheDocument();
    expect(within(region).getByText('Draft')).toBeInTheDocument();
  });

  it('shows an error with a retry, and an empty state', async () => {
    mockSignedIn(memberMe);
    let calls = 0;
    server.use(
      http.get(`${API}/me/courses`, () => {
        calls++;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'x', requestId: 'r' } },
              { status: 500 },
            )
          : page([]);
      }),
    );
    const { user } = renderApp('/');
    expect(await screen.findByText('Could not load your courses')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('You are not in any course yet')).toBeInTheDocument();
  });

  it('administrators also get the course catalog shortcuts and navigation', async () => {
    mockSignedIn(adminMe);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Courses');
    expect(nav).toHaveTextContent('Offerings');
  });
});

describe('the course outline', () => {
  it('a learner sees open items as links and a locked one as title + "Available from", nothing else', async () => {
    mockSignedIn(memberMe);
    const opens = '2030-05-01T09:00:00.000Z';
    mockOffering(
      offering(),
      outline([
        moduleOf(1, [
          item(1, {
            title: 'Syllabus',
            kind: 'file',
            file: { id: 'f', name: 'syllabus.pdf', size: 2048, contentType: 'application/pdf' },
          }),
          item(2, {
            title: 'Final exam brief',
            locked: true,
            availableFrom: opens,
            hasBody: false,
          }),
        ]),
      ]),
    );
    renderApp(`/offerings/${OFFERING_ID}`);
    expect(await screen.findByRole('heading', { name: 'Programming' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Syllabus/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/items/'),
    );
    expect(screen.getByText('Final exam brief')).toBeInTheDocument();
    expect(screen.getByText(/Available from/)).toBeInTheDocument();
    // the locked entry is not a link
    expect(screen.queryByRole('link', { name: /Final exam brief/ })).toBeNull();
    // a learner has no editing or class-list entry points
    expect(screen.queryByRole('link', { name: 'Edit content' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Class list|People/ })).toBeNull();
  });

  it('an instructor sees hidden entries flagged, and the editing and class-list links', async () => {
    mockSignedIn(memberMe);
    mockOffering(
      offering({ myParticipation: 'instructor', status: 'draft' }),
      outline(
        [moduleOf(1, [item(1, { title: 'Secret draft', published: false })], { published: false })],
        true,
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}`);
    expect(await screen.findByText('Secret draft')).toBeInTheDocument();
    expect(screen.getAllByText('Hidden from learners').length).toBeGreaterThan(0);
    expect(screen.getByText(/Draft: learners cannot see this course/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit content' })).toHaveAttribute(
      'href',
      `/offerings/${OFFERING_ID}/build`,
    );
    expect(screen.getByRole('link', { name: 'Class list' })).toBeInTheDocument();
  });

  it('says so when the course does not exist for me (404)', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(base, () =>
        HttpResponse.json(
          {
            error: {
              code: 'offering_not_found',
              message: 'The offering does not exist',
              requestId: 'r',
            },
          },
          { status: 404 },
        ),
      ),
      http.get(`${base}/outline`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'offering_not_found',
              message: 'The offering does not exist',
              requestId: 'r',
            },
          },
          { status: 404 },
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}`);
    expect(await screen.findByText('Could not open this course')).toBeInTheDocument();
    expect(screen.getByText('The offering does not exist')).toBeInTheDocument();
  });
});

describe('an item', () => {
  const itemUrl = `${base}/items/a1000000-0000-7000-8000-000000000001`;
  const full = {
    id: 'a1000000-0000-7000-8000-000000000001',
    moduleId: 'b1000000-0000-7000-8000-000000000001',
    kind: 'text' as const,
    title: 'Reading',
    published: true,
    availableFrom: null,
    locked: false,
    url: null,
    file: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('renders the stored text tree as text: markup is shown, never run', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(itemUrl, () =>
        HttpResponse.json({
          ...full,
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
              },
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'bad',
                    marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                  },
                ],
              },
              { type: 'script', content: [{ type: 'text', text: 'ignored' }] },
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'good',
                    marks: [
                      { type: 'link', attrs: { href: 'https://example.org/' } },
                      { type: 'bold' },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
    const { container } = renderApp(`/offerings/${OFFERING_ID}/items/${full.id}`);
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByText('ignored')).toBeNull();
    expect(screen.getByText('bad').closest('a')).toBeNull(); // the javascript: link is dropped, the text stays
    const good = screen.getByRole('link', { name: 'good' });
    expect(good).toHaveAttribute('href', 'https://example.org/');
    expect(good).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(good).toHaveAttribute('target', '_blank');
  });

  it('a locked item shows only when it opens', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(itemUrl, () =>
        HttpResponse.json({
          ...full,
          locked: true,
          body: null,
          availableFrom: '2030-01-01T00:00:00.000Z',
        }),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${full.id}`);
    expect(await screen.findByText(/This opens on/)).toBeInTheDocument();
  });

  it('a file item downloads through a signed URL fetched on click', async () => {
    mockSignedIn(memberMe);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    server.use(
      http.get(itemUrl, () =>
        HttpResponse.json({
          ...full,
          kind: 'file',
          body: null,
          file: { id: 'f', name: 'notes.pdf', size: 1500, contentType: 'application/pdf' },
        }),
      ),
      http.get(`${itemUrl}/download`, () =>
        HttpResponse.json({
          url: '/api/storage/download/token',
          expiresAt: '2030-01-01T00:00:00.000Z',
          fileName: 'notes.pdf',
          inline: true,
        }),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${full.id}`);
    await user.click(await screen.findByRole('button', { name: 'Download notes.pdf' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('/api/storage/download/token', '_blank', 'noopener'),
    );
    open.mockRestore();
  });
});

describe('the builder', () => {
  const m1 = moduleOf(1, [
    item(1, { title: 'First' }),
    item(2, { title: 'Second' }),
    item(3, { title: 'Third' }),
  ]);
  const m2 = moduleOf(2, [item(4, { title: 'Elsewhere' })]);

  function mockBuilder(canEdit = true) {
    mockSignedIn(memberMe);
    mockOffering(
      offering({ myParticipation: 'instructor', status: 'draft' }),
      outline([m1, m2], canEdit),
    );
  }
  const titles = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

  it('says editing is for instructors when the outline is read only', async () => {
    mockBuilder(false);
    renderApp(`/offerings/${OFFERING_ID}/build`);
    expect(await screen.findByText('You cannot edit this course')).toBeInTheDocument();
  });

  it('shows modules and items with accessible controls named after their target', async () => {
    mockBuilder();
    renderApp(`/offerings/${OFFERING_ID}/build`);
    expect(await screen.findByRole('heading', { name: 'Module 1' })).toBeInTheDocument();
    for (const name of [
      'Move module Module 2 up',
      'Rename module Module 1',
      'Delete module Module 1',
      'Drag module Module 1',
      'Move Second down',
      'Edit First',
      'Delete Third',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Move module Module 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move First up' })).toBeDisabled();
  });

  it('moving a module with the button reorders at once and tells the server where it went', async () => {
    mockBuilder();
    let sent: unknown;
    server.use(
      http.post(`${base}/modules/${m2.id}/move`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          id: m2.id,
          title: m2.title,
          published: true,
          availableFrom: null,
        });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await screen.findByRole('heading', { name: 'Module 1' });
    await user.click(screen.getByRole('button', { name: 'Move module Module 2 up' }));
    expect(titles().slice(0, 2)).toEqual(['Module 2', 'Module 1']);
    await waitFor(() => expect(sent).toEqual({ after: null }));
    expect(screen.getByText(/Module 2 moved to position 1 of 2/)).toBeInTheDocument();
  });

  it('puts the order back and says why when the server refuses a move', async () => {
    mockBuilder();
    server.use(
      http.post(`${base}/items/${m1.items[2]?.id}/move`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'offering_archived',
              message: 'The offering is archived and can no longer be changed',
              requestId: 'r',
            },
          },
          { status: 409 },
        ),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await screen.findByRole('heading', { name: 'Module 1' });
    await user.click(screen.getByRole('button', { name: 'Move Third up' }));
    expect(
      await screen.findByText('The offering is archived and can no longer be changed'),
    ).toBeInTheDocument();
    const order = screen.getAllByText(/^(First|Second|Third)$/).map((e) => e.textContent);
    expect(order).toEqual(['First', 'Second', 'Third']); // back where it was
  });

  it('moves an item to another module (after its last item)', async () => {
    mockBuilder();
    let sent: unknown;
    server.use(
      http.post(`${base}/items/${m1.items[0]?.id}/move`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          ...m1.items[0],
          moduleId: m2.id,
          body: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await screen.findByRole('heading', { name: 'Module 1' });
    await user.selectOptions(screen.getByLabelText('Move First to another module'), m2.id);
    await waitFor(() => expect(sent).toEqual({ moduleId: m2.id, after: m2.items[0]?.id }));
  });

  it('deleting asks first and NAMES the target; cancelling deletes nothing', async () => {
    mockBuilder();
    let deleted = 0;
    server.use(
      http.delete(`${base}/items/${m1.items[2]?.id}`, () => {
        deleted++;
        return HttpResponse.json({ status: 'deleted' });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await screen.findByRole('heading', { name: 'Module 1' });
    await user.click(screen.getByRole('button', { name: 'Delete Third' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete “Third”?' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deleted).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Delete Third' }));
    await user.click(await screen.findByRole('button', { name: 'Delete “Third”' }));
    await waitFor(() => expect(deleted).toBe(1));
    await waitFor(() => expect(screen.queryByText('Third')).toBeNull());
    expect(screen.getByText('Deleted “Third”.')).toBeInTheDocument();
  });

  it('adds a link item and shows it without refetching the outline', async () => {
    mockBuilder();
    let outlineCalls = 0;
    server.use(
      http.get(`${base}/outline`, () => {
        outlineCalls++;
        return HttpResponse.json(outline([m1, m2], true));
      }),
      http.post(`${base}/modules/${m2.id}/items`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          kind: 'link',
          title: 'Docs',
          url: 'https://docs.example.org',
          published: false,
        });
        return HttpResponse.json(
          {
            ...item(9, {
              title: 'Docs',
              kind: 'link',
              url: 'https://docs.example.org/',
              published: false,
              moduleId: m2.id,
            }),
            body: null,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          { status: 201 },
        );
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await screen.findByRole('heading', { name: 'Module 2' });
    const card = screen.getByRole('heading', { name: 'Module 2' }).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Add link' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Docs');
    await user.clear(within(dialog).getByLabelText('Web address'));
    await user.type(within(dialog).getByLabelText('Web address'), 'https://docs.example.org');
    await user.click(within(dialog).getByRole('button', { name: 'Add link' }));
    expect(await within(card).findByText('Docs')).toBeInTheDocument();
    expect(outlineCalls).toBe(1);
  });

  it('publishes the course from the builder', async () => {
    mockBuilder();
    let called = false;
    server.use(
      http.post(`${base}/publish`, () => {
        called = true;
        return HttpResponse.json(offering({ myParticipation: 'instructor', status: 'published' }));
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/build`);
    await user.click(await screen.findByRole('button', { name: 'Publish course' }));
    await waitFor(() => expect(called).toBe(true));
    expect(await screen.findByRole('button', { name: 'Unpublish course' })).toBeInTheDocument();
  });
});

describe('the offerings page', () => {
  it('creates an offering with the optional label and title left empty (they are not sent)', async () => {
    mockSignedIn(adminMe);
    let created: Record<string, unknown> | undefined;
    server.use(
      http.get(`${API}/offerings`, () => page([])),
      http.get(`${API}/courses`, () => page([course()])),
      http.get(`${API}/terms`, () =>
        page([
          {
            id: '33000000-0000-7000-8000-000000000001',
            academicYearId: '34000000-0000-7000-8000-000000000001',
            name: 'Semester 1',
            startDate: '2026-06-01',
            endDate: '2026-11-30',
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
      http.post(`${API}/offerings`, async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(offering({ myParticipation: null }), { status: 201 });
      }),
    );
    const { user } = renderApp('/offerings');
    await user.click(
      (await screen.findAllByRole('button', { name: 'New offering' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: /CS101/ })).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(dialog).getByLabelText('Course'),
      within(dialog).getByRole('option', { name: /CS101/ }),
    );
    await user.selectOptions(
      within(dialog).getByLabelText('Term'),
      within(dialog).getByRole('option', { name: 'Semester 1' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create offering' }));
    await waitFor(() => expect(created).toBeDefined());
    expect(created).toMatchObject({
      courseId: course().id,
      termId: '33000000-0000-7000-8000-000000000001',
    });
    expect(created).not.toHaveProperty('label');
    expect(created).not.toHaveProperty('titleOverride');
  });
});

describe('people', () => {
  const people = `${base}/participants`;

  it('an administrator sees the roles as controls and removing names the person', async () => {
    mockSignedIn(adminMe);
    let removed = false;
    server.use(
      http.get(base, () => HttpResponse.json(offering({ myParticipation: null }))),
      http.get(people, () =>
        page([participant(1, { participation: 'instructor' }), participant(2)]),
      ),
      http.get(`${base}/sections`, () => HttpResponse.json({ items: [] })),
      http.delete(`${people}/${participant(2).id}`, () => {
        removed = true;
        return HttpResponse.json({ status: 'removed' });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/people`);
    expect(await screen.findByText('Person 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Role of Person 1')).toHaveValue('instructor');
    await user.click(screen.getByRole('button', { name: 'Remove Person 2' }));
    expect(await screen.findByRole('heading', { name: 'Remove Person 2?' })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove Person 2' }),
    );
    await waitFor(() => expect(removed).toBe(true));
    await waitFor(() => expect(screen.queryByText('Person 2')).toBeNull());
  });

  it('an instructor only reads the class list: no controls', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(base, () => HttpResponse.json(offering({ myParticipation: 'instructor' }))),
      http.get(people, () => page([participant(1)])),
    );
    renderApp(`/offerings/${OFFERING_ID}/people`);
    expect(await screen.findByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a person' })).toBeNull();
    expect(screen.queryByText('Enrolled sections')).toBeNull();
  });
});

describe('the course catalog', () => {
  it('filters by "no department" and creates a course without a department', async () => {
    mockSignedIn(adminMe);
    const queries: string[] = [];
    let created: unknown;
    server.use(
      http.get(`${API}/departments`, () =>
        page([
          {
            id: 'd1000000-0000-7000-8000-000000000001',
            code: 'CSE',
            name: 'Computing',
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
      http.get(`${API}/courses`, ({ request }) => {
        queries.push(new URL(request.url).search);
        return page([
          course(),
          course({
            id: '22000000-0000-7000-8000-000000000001',
            code: 'ELX1',
            title: 'Photography',
            credits: null,
          }),
        ]);
      }),
      http.post(`${API}/courses`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(course({ code: 'SKL1', title: 'Excel skills' }), { status: 201 });
      }),
    );
    const { user } = renderApp('/courses');
    expect(await screen.findByText('Photography')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Department'), 'none');
    await waitFor(() => expect(queries.some((q) => q.includes('department=none'))).toBe(true));

    await user.click(screen.getByRole('button', { name: 'New course' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Course code'), 'SKL1');
    await user.type(within(dialog).getByLabelText('Title'), 'Excel skills');
    await user.click(within(dialog).getByRole('button', { name: 'Create course' }));
    await waitFor(() => expect(created).toMatchObject({ code: 'SKL1', title: 'Excel skills' }));
    expect(created).not.toHaveProperty('departmentId');
  });

  it('validates the form with the words of the form before sending anything', async () => {
    mockSignedIn(adminMe);
    server.use(
      http.get(`${API}/departments`, () => page([])),
      http.get(`${API}/courses`, () => page([])),
    );
    const { user } = renderApp('/courses');
    await user.click(
      (await screen.findAllByRole('button', { name: 'New course' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create course' }));
    expect(await within(dialog).findByText('Course code is required.')).toBeInTheDocument();
    expect(within(dialog).getByText('Title is required.')).toBeInTheDocument();
  });
});
