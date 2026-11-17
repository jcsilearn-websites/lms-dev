import type { NotificationSettings, Suppression } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// Step 13, institution admins: the college's notification settings and the list of bouncing addresses (clear = confirm
// dialog that names the address; the row leaves the cached list).

const channels = { email: true, inApp: true };
const settings: NotificationSettings = {
  defaults: {
    learning_deadlines: channels,
    learning_grades: channels,
    learning_content: channels,
    teaching_grading: channels,
    teaching_updates: channels,
    admin: channels,
  },
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  digestHour: 7,
  fromName: null,
  replyTo: null,
  fromAddress: null,
  timeZone: 'Asia/Kolkata',
};

describe('college notification settings', () => {
  it('saves defaults, quiet hours, the digest hour and the sender', async () => {
    mockSignedIn();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API}/notifications/settings`, () => HttpResponse.json(settings)),
      http.patch(`${API}/notifications/settings`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...settings, ...sent });
      }),
    );
    const { user } = renderApp('/settings/notifications');
    expect(
      await screen.findByRole('heading', { name: 'Notification settings' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Kolkata/)).toBeInTheDocument();
    expect(screen.getByText(/sent from the JCS iLearn address/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Default email: New course content' }));
    await user.type(screen.getByLabelText('Sender name (optional)'), 'Alpha Exams Office');
    await user.type(screen.getByLabelText('Reply-to address (optional)'), 'office@alpha.test');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toMatchObject({
      defaults: { learning_content: { email: false, inApp: true } },
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      digestHour: 7,
      fromName: 'Alpha Exams Office',
      replyTo: 'office@alpha.test',
    });
    expect(await screen.findByText('Notification settings saved')).toBeInTheDocument();
  });

  it('a member is sent away (the API refuses anyway)', async () => {
    mockSignedIn(memberMe);
    const { router } = renderApp('/settings/notifications');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

describe('bouncing addresses', () => {
  const row: Suppression = {
    id: '50000000-0000-7000-8000-000000000001',
    email: 'mia@alpha.test',
    reason: 'bounce',
    detail: 'bounce',
    createdAt: '2026-11-10T08:00:00.000Z',
    userId: '00000000-0000-7000-8000-000000000002',
    displayName: 'Mia Member',
  };

  it('lists who is not emailed and why; clearing asks first and names the address', async () => {
    mockSignedIn();
    let cleared = false;
    server.use(
      http.get(`${API}/email/suppressions`, () =>
        HttpResponse.json({ items: [row], nextCursor: null }),
      ),
      http.delete(`${API}/email/suppressions/:id`, () => {
        cleared = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp('/settings/email');
    expect(await screen.findByText('mia@alpha.test')).toBeInTheDocument();
    expect(screen.getByText(/Bounced \(address does not exist/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear mia@alpha.test' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Send email to mia@alpha.test again?');
    expect(cleared).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Clear mia@alpha.test' }));
    expect(await screen.findByText('No bouncing addresses')).toBeInTheDocument();
    expect(cleared).toBe(true);
  });

  it('an admin whose own address bounces gets a link to this list in the banner', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/me/email-status`, () =>
        HttpResponse.json({
          email: 'admin@alpha.test',
          suppressed: true,
          reason: 'bounce',
          since: '2026-11-10T00:00:00.000Z',
        }),
      ),
    );
    renderApp('/');
    const banner = await screen.findByRole('region', { name: 'Email delivery problem' });
    expect(within(banner).getByRole('link', { name: 'Review bouncing addresses' })).toHaveAttribute(
      'href',
      '/settings/email',
    );
  });
});
