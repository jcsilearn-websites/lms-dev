import type { MeResponse, MfaStatus } from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from './render';
import { API, adminMe, errorBody, member, mockSignedIn, mockSignedOut, server } from './server';

// Two-step sign-in on screen (step 14c part 3): the second step of a sign-in, the enrolment pages, the step-up dialog that
// repeats the refused request, and the security page.

const status = (over: Partial<MfaStatus> = {}): MfaStatus => ({
  required: true,
  enrolled: true,
  enrolledAt: '2026-03-10T09:00:00.000Z',
  recoveryCodesRemaining: 10,
  canDisable: false,
  ...over,
});
const secret = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/JCS%20iLearn:admin%40alpha.test?secret=JBSWY3DPEHPK3PXP',
};
const codes = Array.from({ length: 10 }, (_, i) => `ABCDE-${String(i).padStart(5, '0')}`);
const refuse = (code: string, message: string, httpStatus: number) =>
  HttpResponse.json(errorBody(code, message), { status: httpStatus });

describe('the second step of a sign-in', () => {
  const signIn = async (user: ReturnType<typeof renderApp>['user']) => {
    await user.type(await screen.findByLabelText('Email'), 'admin@alpha.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
  };

  it('asks for the code, says when it is wrong, and signs in with the right one', async () => {
    mockSignedOut();
    const sent: unknown[] = [];
    server.use(
      http.post(`${API}/auth/login`, () => HttpResponse.json({ step: 'totp' }, { status: 202 })),
      http.post(`${API}/auth/mfa/verify`, async ({ request }) => {
        sent.push(await request.json());
        if (sent.length === 1) return refuse('mfa_invalid_code', 'That code is not valid', 401);
        mockSignedIn(adminMe);
        return HttpResponse.json(adminMe);
      }),
    );
    const { user } = renderApp('/login');
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeInTheDocument();
    const input = await screen.findByLabelText('Code from your authenticator app');
    await user.type(input, '12');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('6 digits');
    expect(sent).toHaveLength(0);
    await user.clear(input);
    await user.type(input, '111111');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That code is not valid')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code from your authenticator app'), '222 222');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(sent).toEqual([{ code: '111111' }, { code: '222222' }]);
  });

  it('takes a recovery code, shows how long a lock lasts and offers to start again when the attempt ended', async () => {
    mockSignedOut();
    let attempt = 0;
    let sent: unknown;
    server.use(
      http.post(`${API}/auth/login`, () => HttpResponse.json({ step: 'totp' }, { status: 202 })),
      http.post(`${API}/auth/mfa/verify`, async ({ request }) => {
        sent = await request.json();
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(errorBody('mfa_locked', 'Too many wrong codes'), {
            status: 429,
            headers: { 'retry-after': '120' },
          });
        }
        return refuse('mfa_challenge_invalid', 'This sign-in attempt has ended', 401);
      }),
    );
    const { user } = renderApp('/login');
    await signIn(user);
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText('Recovery code'), 'ABCDE-12345');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 2 minutes');
    expect(sent).toEqual({ recoveryCode: 'ABCDE-12345' });
    await user.type(screen.getByLabelText('Recovery code'), 'ABCDE-12345');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/This sign-in attempt has ended/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('says that a link was sent to a person who has to set it up', async () => {
    mockSignedOut();
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json({ step: 'enrol_email' }, { status: 202 }),
      ),
    );
    const { user } = renderApp('/login');
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(await screen.findByText('admin@alpha.test')).toBeInTheDocument();
    expect(screen.getByText(/30 minutes/)).toBeInTheDocument();
  });
});

describe('the enrolment page of the e-mailed link', () => {
  const walk = async (signedIn: boolean) => {
    if (signedIn) mockSignedIn(adminMe);
    else mockSignedOut();
    const sent: unknown[] = [];
    server.use(
      http.post(`${API}/auth/mfa/enrol/start`, async ({ request }) => {
        sent.push(await request.json());
        if (sent.length === 1)
          return refuse('invalid_credentials', 'Invalid email or password', 401);
        return HttpResponse.json(secret);
      }),
      http.post(`${API}/auth/mfa/enrol/confirm`, async ({ request }) => {
        sent.push(await request.json());
        mockSignedIn(adminMe);
        return HttpResponse.json({ recoveryCodes: codes, me: adminMe });
      }),
    );
    const view = renderApp(`/mfa/enrol?token=${'t'.repeat(43)}`);
    const { user } = view;
    const password = await screen.findByLabelText('Password');
    await user.type(password, 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // a wrong password is said on the form: it never signs anybody out
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
    await user.clear(password);
    await user.type(password, 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('totp-secret')).toHaveTextContent(secret.secret);
    await user.type(screen.getByLabelText('Code from your authenticator app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I have saved these codes' }));
    await user.click(next);
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(sent.at(-1)).toEqual({ code: '123456' });
  };

  it('password again, QR code, first code, recovery codes once, then in', async () => {
    await walk(false);
  });

  it('works in a browser that is already signed in', async () => {
    await walk(true);
  });

  it('says when the link is used up or incomplete', async () => {
    mockSignedOut();
    server.use(
      http.post(`${API}/auth/mfa/enrol/start`, () =>
        refuse('invalid_or_expired_token', 'This link is invalid or has expired', 400),
      ),
    );
    const { user } = renderApp(`/mfa/enrol?token=${'t'.repeat(43)}`);
    await user.type(await screen.findByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This setup has ended');
  });
});

describe('step-up', () => {
  const rows = [member(1, { displayName: 'Tara Target' })];

  const setUp = () => {
    mockSignedIn(adminMe);
    const calls = { suspend: 0, stepUp: [] as unknown[] };
    server.use(
      http.get(`${API}/members/${rows[0]?.userId}`, () => HttpResponse.json(rows[0])),
      http.get(`${API}/members/:userId/profile`, () =>
        refuse('profile_not_found', 'No profile', 404),
      ),
      http.post(`${API}/members/:userId/suspend`, () => {
        calls.suspend += 1;
        return calls.stepUp.length === 0
          ? refuse('mfa_step_up_required', 'Confirm it is you to continue', 403)
          : HttpResponse.json({ ...rows[0], status: 'suspended' });
      }),
      http.post(`${API}/me/mfa/step-up`, async ({ request }) => {
        const body = (await request.json()) as { code?: string };
        if (body.code === '000000')
          return refuse('mfa_invalid_code', 'That code is not valid', 400);
        calls.stepUp.push(body);
        return HttpResponse.json({ validUntil: '2026-03-10T09:10:00.000Z' });
      }),
    );
    return calls;
  };

  const suspend = async (user: ReturnType<typeof renderApp>['user']) => {
    await user.click(await screen.findByRole('button', { name: /^Suspend/ }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: /Suspend/ }));
    return screen.findByRole('dialog', { name: 'Confirm it is you' });
  };

  it('opens over the confirm dialog, and the refused request is sent again after the code', async () => {
    const calls = setUp();
    const { user } = renderApp(`/members/${rows[0]?.userId}`);
    const dialog = await suspend(user);
    const input = within(dialog).getByLabelText('Code from your authenticator app');
    await user.type(input, '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and continue' }));
    expect(await within(dialog).findByText('That code is not valid')).toBeInTheDocument();
    expect(calls.suspend).toBe(1);
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and continue' }));
    await waitFor(() => expect(calls.suspend).toBe(2));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Confirm it is you' })).toBeNull(),
    );
    expect(calls.stepUp).toEqual([{ code: '123456' }]);
  });

  it('declined: nothing is sent again and the refusal is shown', async () => {
    const calls = setUp();
    const { user } = renderApp(`/members/${rows[0]?.userId}`);
    const dialog = await suspend(user);
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Confirm it is you to continue')).toBeInTheDocument();
    expect(calls.suspend).toBe(1);
  });
});

describe('sign-in security', () => {
  it('new recovery codes after a warning, shown once; the role keeps it on', async () => {
    mockSignedIn(adminMe);
    let regenerated = 0;
    server.use(
      http.get(`${API}/me/mfa`, () => HttpResponse.json(status({ recoveryCodesRemaining: 2 }))),
      http.post(`${API}/me/mfa/recovery-codes`, () => {
        regenerated += 1;
        return HttpResponse.json({ recoveryCodes: codes });
      }),
    );
    const { user } = renderApp('/me/security');
    expect(await screen.findByText(/2 codes left\. Make new ones soon/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be turned off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off two-step sign-in' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('stop working at once');
    await user.click(within(dialog).getByRole('button', { name: 'Make new codes' }));
    expect(await screen.findByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();
    expect(regenerated).toBe(1);
    await user.click(screen.getByRole('checkbox', { name: 'I have saved these codes' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByRole('button', { name: 'Replace authenticator' }),
    ).toBeInTheDocument();
  });

  it('replaces the authenticator, and turns off where no role needs it', async () => {
    mockSignedIn(adminMe);
    const sent: string[] = [];
    server.use(
      http.get(`${API}/me/mfa`, () =>
        HttpResponse.json(status({ required: false, canDisable: true })),
      ),
      http.post(`${API}/me/mfa/replace/start`, () => HttpResponse.json(secret)),
      http.post(`${API}/me/mfa/replace/confirm`, () => {
        sent.push('confirm');
        return HttpResponse.json({ status: 'ok' });
      }),
      http.post(`${API}/me/mfa/disable`, () => {
        sent.push('disable');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    const { user } = renderApp('/me/security');
    await user.click(await screen.findByRole('button', { name: 'Replace authenticator' }));
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code from your authenticator app'), '654321');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await user.click(await screen.findByRole('button', { name: 'Turn off two-step sign-in' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(sent).toEqual(['confirm', 'disable']));
  });

  it('says it when it is not set up', async () => {
    mockSignedIn({ ...adminMe, role: 'member', permissions: [] } as MeResponse);
    server.use(
      http.get(`${API}/me/mfa`, () =>
        HttpResponse.json(
          status({ required: false, enrolled: false, enrolledAt: null, recoveryCodesRemaining: 0 }),
        ),
      ),
    );
    renderApp('/me/security');
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
  });
});
