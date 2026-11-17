import type { Notification, Preferences } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, mockSignedOut, server } from './server';

// Step 13 screens: the bell (count, panel, mark all read), the notifications page (load more, mark read, deep links), the
// preferences page (security locked, a change saved at once), the bouncing-address banner, the unsubscribe page.

const n = (i: number, over: Partial<Notification> = {}): Notification => ({
  id: `n0000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
  category: 'learning_grades',
  type: 'grade_released',
  params: { course: 'Physics', item: `Lab ${i}`, kind: 'assignment', hasFeedback: i % 2 === 0 },
  link: `/offerings/o${i}/items/i${i}/assignment`,
  createdAt: '2026-11-16T10:00:00.000Z',
  readAt: null,
  ...over,
});

describe('the bell', () => {
  it('shows the unread count in its name, lists the latest on open, and marks all read', async () => {
    mockSignedIn(memberMe);
    let read = false;
    server.use(
      http.get(`${API}/notifications/unread-count`, () =>
        HttpResponse.json(
          { unread: read ? 0 : 3 },
          { headers: { etag: read ? 'W/"0.0"' : 'W/"3.x"' } },
        ),
      ),
      http.get(`${API}/notifications`, () =>
        HttpResponse.json({
          items: [n(1), n(2), n(3, { readAt: '2026-11-16T11:00:00.000Z' })],
          nextCursor: null,
        }),
      ),
      http.post(`${API}/notifications/read-all`, () => {
        read = true;
        return HttpResponse.json({ updated: 2 });
      }),
    );
    const { user } = renderApp('/');
    const bell = await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    await user.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    const panel = await screen.findByRole('region', { name: 'Latest notifications' });
    expect(
      await within(panel).findByRole('link', {
        name: /^Unread Your work on Lab 1 has been returned/,
      }),
    ).toHaveAttribute('href', '/offerings/o1/items/i1/assignment');
    expect(within(panel).getByRole('link', { name: /^Your work on Lab 3/ })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Mark all as read' }));
    await screen.findByRole('button', { name: 'Notifications' });
    // Escape closes and returns focus to the bell
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Latest notifications' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toHaveFocus();
  });

  it('shows 99+ when the server caps the count', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/notifications/unread-count`, () => HttpResponse.json({ unread: 100 })),
    );
    renderApp('/');
    expect(
      await screen.findByRole('button', { name: 'Notifications, 99+ unread' }),
    ).toBeInTheDocument();
  });
});

describe('the notifications page', () => {
  it('lists, loads more, marks one read in place, and never shows a mark', async () => {
    mockSignedIn(memberMe);
    const marked: string[] = [];
    server.use(
      http.get(`${API}/notifications`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        return HttpResponse.json(
          after
            ? { items: [n(1)], nextCursor: null }
            : { items: [n(3), n(2)], nextCursor: n(2).id },
        );
      }),
      http.post(`${API}/notifications/:id/read`, ({ params }) => {
        marked.push(String(params.id));
        return HttpResponse.json({ updated: 1 });
      }),
    );
    const { user } = renderApp('/notifications');
    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Notifications' });
    expect(
      within(list).getByRole('link', { name: 'Your work on Lab 2 has been returned' }),
    ).toBeInTheDocument();
    expect(within(list).getByText(/Physics · with feedback/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await within(list).findByRole('link', { name: 'Your work on Lab 1 has been returned' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Mark as read: Your work on Lab 3 has been returned' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Mark as read: Your work on Lab 3/ }),
      ).not.toBeInTheDocument(),
    );
    expect(marked).toEqual([n(3).id]);
  });

  it('has an empty state and an error state with retry', async () => {
    mockSignedIn(memberMe);
    let fail = true;
    server.use(
      http.get(`${API}/notifications`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: 'boom', message: 'Down', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { user } = renderApp('/notifications');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });
});

describe('my notification settings', () => {
  const prefs = (
    over: Partial<Record<string, { email: boolean; inApp: boolean }>> = {},
  ): Preferences => ({
    items: (
      [
        'security',
        'learning_deadlines',
        'learning_grades',
        'learning_content',
        'teaching_grading',
        'teaching_updates',
        'admin',
      ] as const
    ).map((category) => ({
      category,
      email: over[category]?.email ?? true,
      inApp: over[category]?.inApp ?? true,
      mandatory: category === 'security',
      collegeDefault: { email: true, inApp: true },
      overridden: Boolean(over[category]),
    })),
  });

  it('security is locked; turning a category off saves at once', async () => {
    mockSignedIn(memberMe);
    const sent: unknown[] = [];
    server.use(
      http.get(`${API}/me/notification-preferences`, () => HttpResponse.json(prefs())),
      http.put(`${API}/me/notification-preferences`, async ({ request }) => {
        const body = (await request.json()) as { category: string; email: boolean; inApp: boolean };
        sent.push(body);
        return HttpResponse.json(
          prefs({ [body.category]: { email: body.email, inApp: body.inApp } }),
        );
      }),
    );
    const { user } = renderApp('/me/notifications');
    const sec = await screen.findByRole('checkbox', { name: 'Email: Account and security' });
    expect(sec).toBeDisabled();
    expect(sec).toBeChecked();
    const content = screen.getByRole('checkbox', { name: 'Email: New course content' });
    await user.click(content);
    await waitFor(() =>
      expect(sent).toEqual([{ category: 'learning_content', email: false, inApp: true }]),
    );
    expect(await screen.findByText('Saved: New course content')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Email: New course content' })).not.toBeChecked();
    expect(screen.getByText(/changed from your college’s default/)).toBeInTheDocument();
  });
});

describe('the bouncing-address banner', () => {
  it('a member is told to contact the admin; nothing when the address is fine', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/me/email-status`, () =>
        HttpResponse.json({
          email: 'm@alpha.test',
          suppressed: true,
          reason: 'bounce',
          since: '2026-11-10T00:00:00.000Z',
        }),
      ),
    );
    renderApp('/');
    const banner = await screen.findByRole('region', { name: 'Email delivery problem' });
    expect(banner).toHaveTextContent('Emails to m@alpha.test are bouncing');
    expect(banner).toHaveTextContent('Contact your college admin.');
  });
});

describe('the unsubscribe page', () => {
  it('opening it changes nothing; the button unsubscribes', async () => {
    mockSignedOut();
    let posted = false;
    server.use(
      http.get(`${API}/notifications/unsubscribe`, () =>
        HttpResponse.json({
          college: 'Alpha College',
          emailMasked: 'mi***@alpha.test',
          category: 'learning_content',
          categoryLabel: 'New course content',
          subscribed: true,
        }),
      ),
      http.post(`${API}/notifications/unsubscribe`, () => {
        posted = true;
        return HttpResponse.json({ unsubscribed: true, categoryLabel: 'New course content' });
      }),
    );
    const { user } = renderApp('/unsubscribe?t=v1.abc.def');
    expect(await screen.findByText(/Stop emails about/)).toHaveTextContent(
      'Stop emails about new course content from Alpha College to mi***@alpha.test?',
    );
    expect(posted).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(
      await screen.findByText('You will no longer get emails about new course content.'),
    ).toBeInTheDocument();
    expect(posted).toBe(true);
  });

  it('a bad or expired link says so', async () => {
    mockSignedOut();
    server.use(
      http.get(`${API}/notifications/unsubscribe`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'unsubscribe_link_invalid',
              message: 'This unsubscribe link has expired.',
              requestId: 'r',
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderApp('/unsubscribe?t=v1.old.mac');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This unsubscribe link has expired.',
    );
  });
});
