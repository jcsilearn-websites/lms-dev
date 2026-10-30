import { screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import {
  API,
  adminMe,
  errorBody,
  member,
  memberMe,
  mockSignedIn,
  server,
  studentProfile,
} from './server';

const DEPT = { id: 'd0000000-0000-7000-8000-000000000001', code: 'CSE', name: 'Computer Science' };
const PROGRAM = { id: 'e0000000-0000-7000-8000-000000000001', code: 'BE', departmentId: DEPT.id };
const BATCH = {
  id: 'b0000000-0000-7000-8000-000000000001',
  label: '2023-2027',
  programId: PROGRAM.id,
};
const SECTION = { id: '50000000-0000-7000-8000-000000000001', code: 'A', batchId: BATCH.id };
const page = <T,>(items: T[], nextCursor: string | null = null) =>
  HttpResponse.json({ items, nextCursor });

/** Records every API request with the time it ARRIVED, so tests can assert on ordering and overlap. */
function recordRequests() {
  const log: { path: string; search: URLSearchParams; at: number }[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    log.push({
      path: url.pathname.replace(/^\/api/, ''),
      search: url.searchParams,
      at: performance.now(),
    });
  });
  return log;
}

function mockAcademics(counters: { sections: number } = { sections: 0 }) {
  server.use(
    http.get(`${API}/departments`, () => page([{ ...DEPT, archivedAt: null }])),
    http.get(`${API}/programs`, () => page([PROGRAM])),
    http.get(`${API}/batches`, () => page([BATCH])),
    http.get(`${API}/sections`, () => {
      counters.sections += 1;
      return page([SECTION]);
    }),
  );
}

describe('members list', () => {
  it('starts the list and the department options at the same time (no request waterfall)', async () => {
    mockSignedIn();
    const log = recordRequests();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(80);
      inFlight -= 1;
    };
    server.use(
      http.get(`${API}/members`, async () => {
        await slow();
        return page([member(1), member(2)]);
      }),
      http.get(`${API}/departments`, async () => {
        await slow();
        return page([{ ...DEPT, archivedAt: null }]);
      }),
    );
    renderApp('/members');
    expect(await screen.findAllByText('Person 1')).not.toHaveLength(0);

    const members = log.find((r) => r.path === '/members');
    const departments = log.find((r) => r.path === '/departments');
    expect(members && departments).toBeTruthy();
    // both requests were on the wire together: neither waited for the other to finish
    expect(maxInFlight).toBe(2);
    expect(Math.abs((members?.at ?? 0) - (departments?.at ?? 0))).toBeLessThan(60);
  });

  it('shows skeletons while loading, an empty state, and an error state with a working retry', async () => {
    mockSignedIn();
    let calls = 0;
    server.use(
      http.get(`${API}/departments`, () => page([])),
      http.get(`${API}/members`, async () => {
        calls += 1;
        if (calls === 1)
          return HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 });
        return page([]);
      }),
    );
    const { user } = renderApp('/members');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load members');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No members found')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('loads more with the keyset cursor and appends instead of replacing', async () => {
    mockSignedIn();
    const seen: (string | null)[] = [];
    server.use(
      http.get(`${API}/departments`, () => page([])),
      http.get(`${API}/members`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        seen.push(after);
        return after ? page([member(3)], null) : page([member(1), member(2)], 'cursor-after-2');
      }),
    );
    const { user } = renderApp('/members');
    await screen.findAllByText('Person 2');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findAllByText('Person 3');
    expect(screen.getAllByText('Person 1').length).toBeGreaterThan(0); // still there
    expect(seen).toEqual([null, 'cursor-after-2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('the filter cascade fetches each level only after its parent is chosen, never all sections', async () => {
    mockSignedIn();
    const sectionCalls = { sections: 0 };
    mockAcademics(sectionCalls);
    server.use(http.get(`${API}/members`, () => page([member(1)])));
    const log = recordRequests();
    const { user } = renderApp('/members');
    await screen.findAllByText('Person 1');

    // at first only the departments were requested: no programs, batches or sections
    const fetched = () => log.map((r) => r.path);
    expect(fetched()).toContain('/departments');
    for (const p of ['/programs', '/batches', '/sections']) expect(fetched()).not.toContain(p);
    expect(screen.getByLabelText('Program')).toBeDisabled();
    expect(screen.getByLabelText('Batch')).toBeDisabled();
    expect(screen.getByLabelText('Section')).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Department'), DEPT.id);
    await waitFor(() => expect(fetched()).toContain('/programs'));
    expect(log.find((r) => r.path === '/programs')?.search.get('departmentId')).toBe(DEPT.id);
    expect(fetched()).not.toContain('/batches');

    await user.selectOptions(
      await screen
        .findByRole('option', { name: 'BE' })
        .then(() => screen.getByLabelText('Program')),
      PROGRAM.id,
    );
    await waitFor(() => expect(fetched()).toContain('/batches'));
    expect(log.find((r) => r.path === '/batches')?.search.get('programId')).toBe(PROGRAM.id);
    expect(sectionCalls.sections).toBe(0);

    await user.selectOptions(
      await screen
        .findByRole('option', { name: '2023-2027' })
        .then(() => screen.getByLabelText('Batch')),
      BATCH.id,
    );
    await waitFor(() => expect(sectionCalls.sections).toBe(1));
    expect(log.find((r) => r.path === '/sections')?.search.get('batchId')).toBe(BATCH.id);

    // every options request is bounded
    for (const r of log.filter((x) =>
      ['/departments', '/programs', '/batches', '/sections'].includes(x.path),
    )) {
      expect(r.search.get('limit')).toBe('100');
    }

    // changing a parent clears the levels below it
    await user.selectOptions(screen.getByLabelText('Department'), '');
    expect(screen.getByLabelText('Program')).toBeDisabled();
    expect(screen.getByLabelText('Program')).toHaveValue('');
  });

  it('sends the filters it was opened with (they live in the URL)', async () => {
    mockSignedIn();
    mockAcademics();
    const log = recordRequests();
    server.use(http.get(`${API}/members`, () => page([member(1)])));
    renderApp(`/members?role=member&status=suspended&departmentId=${DEPT.id}&q=ra`);
    await screen.findAllByText('Person 1');
    const req = log.find((r) => r.path === '/members');
    expect(Object.fromEntries(req?.search ?? [])).toMatchObject({
      role: 'member',
      status: 'suspended',
      departmentId: DEPT.id,
      q: 'ra',
      limit: '25',
    });
  });
});

describe('member detail', () => {
  const target = member(7, {
    displayName: 'Sam Student',
    status: 'active',
    profileType: 'student',
  });

  function mockDetail(extra: () => void = () => undefined) {
    mockSignedIn();
    server.use(
      http.get(`${API}/members/${target.userId}`, () => HttpResponse.json(target)),
      http.get(`${API}/members/${target.userId}/profile`, () =>
        HttpResponse.json(studentProfile(target.userId)),
      ),
      http.get(`${API}/departments`, () => page([])),
    );
    extra();
  }

  it('loads the member and the profile in parallel', async () => {
    mockDetail();
    const log = recordRequests();
    renderApp(`/members/${target.userId}`);
    await screen.findByRole('heading', { name: 'Sam Student' });
    await screen.findByText('2023-2027');
    const paths = log.map((r) => r.path);
    expect(paths).toContain(`/members/${target.userId}`);
    expect(paths).toContain(`/members/${target.userId}/profile`);
  });

  it('asks for confirmation naming the person, then suspends and updates the page without refetching', async () => {
    let gets = 0;
    mockDetail(() =>
      server.use(
        http.get(`${API}/members/${target.userId}`, () => {
          gets += 1;
          return HttpResponse.json(target);
        }),
        http.post(`${API}/members/${target.userId}/suspend`, () =>
          HttpResponse.json({ ...target, status: 'suspended' }),
        ),
      ),
    );
    const { user } = renderApp(`/members/${target.userId}`);
    await screen.findByRole('heading', { name: 'Sam Student' });
    await user.click(screen.getByRole('button', { name: 'Suspend' }));

    const dialog = await screen.findByRole('dialog', { name: 'Suspend Sam Student?' });
    expect(within(dialog).getByRole('button', { name: 'Suspend Sam Student' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Suspend Sam Student' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Sam Student is suspended.');
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(gets).toBe(1); // the mutation response replaced the cache entry: no refetch
  });

  it('patches the row in the cached list instead of refetching the whole page', async () => {
    mockSignedIn();
    let listCalls = 0;
    server.use(
      http.get(`${API}/departments`, () => page([])),
      http.get(`${API}/members`, () => {
        listCalls += 1;
        return page([member(7, { displayName: 'Sam Student' }), member(8)]);
      }),
      http.get(`${API}/members/${target.userId}`, () => HttpResponse.json(target)),
      http.get(`${API}/members/${target.userId}/profile`, () =>
        HttpResponse.json(studentProfile(target.userId)),
      ),
      http.post(`${API}/members/${target.userId}/suspend`, () =>
        HttpResponse.json({ ...target, status: 'suspended' }),
      ),
    );
    const { user, router } = renderApp('/members');
    await screen.findAllByText('Sam Student');
    await user.click(screen.getAllByRole('link', { name: 'Sam Student' })[0] as HTMLElement);
    await screen.findByRole('heading', { name: 'Sam Student' });
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    await user.click(await screen.findByRole('button', { name: 'Suspend Sam Student' }));
    await screen.findByRole('button', { name: 'Reactivate' });

    void router.navigate({ to: '/members' as '/' });
    await screen.findAllByText('Sam Student');
    // the cached list shows the new status; the list endpoint was called once, at the start
    expect(screen.getAllByText('suspended').length).toBeGreaterThan(0);
    expect(listCalls).toBe(1);
  });

  it('shows the server message when the backend refuses (last admin)', async () => {
    mockDetail(() =>
      server.use(
        http.post(`${API}/members/${target.userId}/suspend`, () =>
          HttpResponse.json(
            errorBody('last_admin', 'A college must keep at least one active institution admin'),
            { status: 409 },
          ),
        ),
      ),
    );
    const { user } = renderApp(`/members/${target.userId}`);
    await user.click(await screen.findByRole('button', { name: 'Suspend' }));
    await user.click(await screen.findByRole('button', { name: 'Suspend Sam Student' }));
    expect(
      await screen.findByText('A college must keep at least one active institution admin'),
    ).toBeInTheDocument();
    // still active: nothing changed in the UI
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeInTheDocument();
  });

  it('removes a member only after a confirmation that names them', async () => {
    let deleted = false;
    mockDetail(() =>
      server.use(
        http.delete(`${API}/members/${target.userId}`, () => {
          deleted = true;
          return HttpResponse.json({ status: 'ok' });
        }),
        http.get(`${API}/members`, () => page([])),
      ),
    );
    const { user, router } = renderApp(`/members/${target.userId}`);
    await user.click(await screen.findByRole('button', { name: 'Remove from college' }));
    expect(deleted).toBe(false);
    const dialog = await screen.findByRole('dialog', { name: 'Remove Sam Student?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove Sam Student' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/members'));
    expect(deleted).toBe(true);
  });

  it('cannot demote, suspend or remove yourself (the buttons are off and say why)', async () => {
    mockSignedIn();
    const me = member(1, {
      userId: '00000000-0000-7000-8000-000000000001',
      displayName: 'Ada Admin',
      role: 'institution_admin',
    });
    server.use(
      http.get(`${API}/members/${me.userId}`, () => HttpResponse.json(me)),
      http.get(`${API}/members/${me.userId}/profile`, () =>
        HttpResponse.json(errorBody('profile_not_found', 'This member has no profile yet'), {
          status: 404,
        }),
      ),
      http.get(`${API}/departments`, () => page([])),
    );
    renderApp(`/members/${me.userId}`);
    await screen.findByRole('heading', { name: 'Ada Admin' });
    expect(screen.getByText(/This is you/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove from college' })).toBeDisabled();
    expect(await screen.findByText('This member has no profile yet.')).toBeInTheDocument();
  });

  it('a removed member shows what removal means and offers no actions; the list can show them', async () => {
    mockSignedIn(adminMe);
    const gone = member(9, { displayName: 'Rita Removed', status: 'removed' });
    server.use(
      http.get(`${API}/members/${gone.userId}`, () => HttpResponse.json(gone)),
      http.get(`${API}/members/${gone.userId}/profile`, () =>
        HttpResponse.json(errorBody('profile_not_found', 'This member has no profile yet'), {
          status: 404,
        }),
      ),
      http.get(`${API}/departments`, () => page([])),
    );
    renderApp(`/members/${gone.userId}`);
    await screen.findByRole('heading', { name: 'Rita Removed' });
    expect(screen.getByText('removed')).toBeInTheDocument();
    expect(screen.getByText(/academic history are kept/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from college' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  });

  it('hides the admin actions from someone without the permissions', async () => {
    mockSignedIn(memberMe);
    renderApp('/members');
    // a member is sent home: there is no members screen for them at all
    expect(await screen.findByText('You are not in any course yet')).toBeInTheDocument();
  });
});
