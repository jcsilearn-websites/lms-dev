import type { AuditEntryDto } from '@lms/backend/contracts';
import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, mockSignedIn, server } from './server';

const entry = (n: number, over: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
  id: `a0000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  actorUserId: '00000000-0000-7000-8000-000000000001',
  actorName: 'Ada Admin',
  actorEmail: 'admin@alpha.test',
  action: 'member.suspended',
  targetType: 'membership',
  targetId: null,
  metadata: {},
  createdAt: '2026-02-01T10:00:00.000Z',
  ...over,
});

describe('audit log: who did it', () => {
  it('shows the name and email of the actor, "Unknown user" for a removed one and "System" for none', async () => {
    mockSignedIn();
    server.use(
      http.get(`${API}/audit`, () =>
        HttpResponse.json({
          items: [
            entry(1),
            entry(2, {
              actorName: 'Unknown user',
              actorEmail: null,
              actorUserId: '00000000-0000-7000-8000-000000000009',
            }),
            entry(3, {
              actorUserId: null,
              actorName: null,
              actorEmail: null,
              action: 'imports.purge',
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp('/audit');
    // ("Ada Admin" is also the signed-in user in the header: wait for the table itself)
    expect((await screen.findAllByText('Unknown user')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin@alpha.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('System').length).toBeGreaterThan(0);
  });
});
