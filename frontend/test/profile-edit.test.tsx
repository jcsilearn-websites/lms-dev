import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, member, mockSignedIn, server, studentProfile } from './server';

const DEPT = { id: 'd0000000-0000-7000-8000-000000000001', code: 'CSE', name: 'Computer Science' };
const PROGRAM = { id: 'e0000000-0000-7000-8000-000000000001', code: 'BE', departmentId: DEPT.id };
const BATCH = {
  id: 'b0000000-0000-7000-8000-000000000001',
  label: '2023-2027',
  programId: PROGRAM.id,
};
const SEC_A = { id: '50000000-0000-7000-8000-000000000001', code: 'A', batchId: BATCH.id };
const SEC_B = { id: '50000000-0000-7000-8000-000000000002', code: 'B', batchId: BATCH.id };
const page = <T,>(items: T[]) => HttpResponse.json({ items, nextCursor: null });
const stamps = {
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const target = member(7, { displayName: 'Sam Student', profileType: 'student' });

function mock(onPatch: (body: unknown) => void = () => undefined) {
  mockSignedIn();
  const profile = studentProfile(target.userId);
  server.use(
    http.get(`${API}/members/${target.userId}`, () => HttpResponse.json(target)),
    http.get(`${API}/members/${target.userId}/profile`, () => HttpResponse.json(profile)),
    http.patch(`${API}/members/${target.userId}/profile`, async ({ request }) => {
      const body = await request.json();
      onPatch(body);
      return HttpResponse.json({ ...profile, sectionId: SEC_B.id, sectionCode: 'B' });
    }),
    http.get(`${API}/departments`, () => page([{ ...DEPT, ...stamps }])),
    http.get(`${API}/programs`, () => page([PROGRAM])),
    http.get(`${API}/batches`, () => page([BATCH])),
    http.get(`${API}/sections`, () => page([SEC_A, SEC_B])),
  );
}

describe('editing a student profile', () => {
  it('shows the program (name and code) and prefills department, program, batch and section', async () => {
    mock();
    const { user } = renderApp(`/members/${target.userId}`);
    expect(await screen.findByText('2023-2027')).toBeInTheDocument();
    expect(screen.getByText('Bachelor of Engineering (BE)')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));

    await waitFor(() => expect(screen.getByLabelText('Section')).toHaveValue(SEC_A.id));
    expect(screen.getByLabelText('Department')).toHaveValue(DEPT.id);
    expect(screen.getByLabelText('Program')).toHaveValue(PROGRAM.id);
    expect(screen.getByLabelText('Batch')).toHaveValue(BATCH.id);
    expect(screen.getByLabelText('Program')).toBeEnabled();
  });

  it('saving without touching the chain does not resend department, batch or section', async () => {
    let body: Record<string, unknown> | undefined;
    mock((b) => {
      body = b as Record<string, unknown>;
    });
    const { user } = renderApp(`/members/${target.userId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    await waitFor(() => expect(screen.getByLabelText('Section')).toHaveValue(SEC_A.id));
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '+91 98765 43210');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ profileType: 'student', phone: '+91 98765 43210' });
    expect(body).not.toHaveProperty('batchId');
    expect(body).not.toHaveProperty('sectionId');
    expect(body).not.toHaveProperty('departmentId');
  });

  it('picking another section sends the batch and the new section', async () => {
    let body: Record<string, unknown> | undefined;
    mock((b) => {
      body = b as Record<string, unknown>;
    });
    const { user } = renderApp(`/members/${target.userId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    await waitFor(() => expect(screen.getByLabelText('Section')).toHaveValue(SEC_A.id));
    await user.selectOptions(screen.getByLabelText('Section'), SEC_B.id);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ batchId: BATCH.id, sectionId: SEC_B.id });
  });

  it('changing the department clears program, batch and section below it', async () => {
    mock();
    const { user } = renderApp(`/members/${target.userId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    await waitFor(() => expect(screen.getByLabelText('Section')).toHaveValue(SEC_A.id));
    await user.selectOptions(screen.getByLabelText('Department'), '');
    expect(screen.getByLabelText('Program')).toHaveValue('');
    expect(screen.getByLabelText('Batch')).toHaveValue('');
    expect(screen.getByLabelText('Section')).toHaveValue('');
    expect(screen.getByLabelText('Program')).toBeDisabled();
  });
});
