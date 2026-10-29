import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, errorBody, mockSignedIn, server } from './server';

const stamps = {
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const dept = (n: number, code: string) => ({
  id: `d0000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  code,
  name: `${code} department`,
  ...stamps,
});
const page = <T,>(items: T[]) => HttpResponse.json({ items, nextCursor: null });

async function openDepartments() {
  const ctx = renderApp('/academics');
  await ctx.user.click(await screen.findByRole('tab', { name: 'Departments' }));
  return ctx;
}

describe('academic setup', () => {
  it('creates a department: validates first, then adds the row without refetching the list', async () => {
    mockSignedIn();
    let lists = 0;
    let posted: unknown;
    server.use(
      http.get(`${API}/academic-years`, () => page([])),
      http.get(`${API}/departments`, ({ request }) => {
        // the page's own list asks for 25 rows; the 100-row request is the (separate) options list
        if (new URL(request.url).searchParams.get('limit') === '25') lists += 1;
        return page([dept(1, 'ECE')]);
      }),
      http.post(`${API}/departments`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json(dept(2, 'CSE'), { status: 201 });
      }),
    );
    const { user } = await openDepartments();
    await screen.findAllByText('ECE');
    const listsBefore = lists;

    await user.click(screen.getByRole('button', { name: 'Add department' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add department' });
    // empty submit: the contract schema says what is missing, nothing is sent
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Code is required.')).toBeInTheDocument();
    expect(posted).toBeUndefined();

    await user.type(within(dialog).getByLabelText('Code'), 'CSE');
    await user.type(within(dialog).getByLabelText('Name'), 'Computer Science');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('CSE - CSE department added.');
    expect(posted).toEqual({ code: 'CSE', name: 'Computer Science' });
    expect(screen.getAllByText('CSE').length).toBeGreaterThan(0);
    expect(lists).toBe(listsBefore); // no refetch: the created row was put into the cache
  });

  it('archiving asks first, names the target, and shows the server reason when it is refused (409)', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/academic-years`, () => page([])),
      http.get(`${API}/departments`, () => page([dept(1, 'ECE')])),
      http.post(`${API}/departments/${dept(1, 'ECE').id}/archive`, () =>
        HttpResponse.json(
          errorBody(
            'has_active_children',
            'This department still has active programs. Archive them first.',
          ),
          { status: 409 },
        ),
      ),
    );
    const { user } = await openDepartments();
    await screen.findAllByText('ECE');
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Archive ECE - ECE department?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive ECE - ECE department' }));
    expect(
      await screen.findByText('This department still has active programs. Archive them first.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('ECE').length).toBeGreaterThan(0); // still listed
  });

  it('a successful archive removes the row from the list in place', async () => {
    mockSignedIn();
    let lists = 0;
    server.use(
      http.get(`${API}/academic-years`, () => page([])),
      http.get(`${API}/departments`, ({ request }) => {
        // the page's own list asks for 25 rows; the 100-row request is the (separate) options list
        if (new URL(request.url).searchParams.get('limit') === '25') lists += 1;
        return page([dept(1, 'ECE'), dept(2, 'MECH')]);
      }),
      http.post(`${API}/departments/${dept(1, 'ECE').id}/archive`, () =>
        HttpResponse.json({ ...dept(1, 'ECE'), archivedAt: '2026-02-01T00:00:00.000Z' }),
      ),
    );
    const { user } = await openDepartments();
    await screen.findAllByText('MECH');
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Archive ECE - ECE department' }));
    await waitFor(() => expect(screen.queryAllByText('ECE')).toHaveLength(0));
    expect(screen.getAllByText('MECH').length).toBeGreaterThan(0);
    expect(lists).toBe(1);
  });

  it('terms and sections ask for their parent first and never load everything', async () => {
    mockSignedIn();
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) =>
      calls.push(new URL(request.url).pathname.replace(/^\/api/, '')),
    );
    server.use(
      http.get(`${API}/academic-years`, () =>
        page([
          {
            id: 'y0000000-0000-7000-8000-000000000001',
            label: '2025-26',
            startDate: '2025-06-01',
            endDate: '2026-05-31',
            isCurrent: true,
            ...stamps,
          },
        ]),
      ),
      http.get(`${API}/departments`, () => page([dept(1, 'ECE')])),
      http.get(`${API}/terms`, () => page([])),
      http.get(`${API}/sections`, () => page([])),
    );
    const { user } = renderApp('/academics');
    await user.click(await screen.findByRole('tab', { name: 'Terms' }));
    expect(
      await screen.findByText('Choose an academic year to see its terms.'),
    ).toBeInTheDocument();
    expect(calls).not.toContain('/terms');
    await user.selectOptions(
      await screen.findByLabelText('Academic year'),
      'y0000000-0000-7000-8000-000000000001',
    );
    expect(await screen.findByText('No terms yet')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Sections' }));
    expect(
      await screen.findByText('Choose a department, a program and a batch to see its sections.'),
    ).toBeInTheDocument();
    expect(calls).not.toContain('/sections');
  });

  it('tabs work with the arrow keys', async () => {
    mockSignedIn();
    server.use(http.get(`${API}/academic-years`, () => page([])));
    const { user } = renderApp('/academics');
    const first = await screen.findByRole('tab', { name: 'Academic years' });
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Terms' })).toHaveAttribute('aria-selected', 'true');
  });
});
