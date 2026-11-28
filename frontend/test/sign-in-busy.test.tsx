import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signInRetryTiming } from '../src/shared/api/signInRetry';
import { renderApp } from './render';
import { API, adminMe, errorBody, mockSignedIn, mockSignedOut, server } from './server';

// A saturated server answers a sign-in with 503 `busy`. The page retries by itself (three more attempts, jittered), says
// that many people are signing in, and shows an ordinary error when it still does not get through.

const busy = () =>
  HttpResponse.json(errorBody('busy', 'The server is busy, please retry shortly'), {
    status: 503,
    headers: { 'retry-after': '2' },
  });
const NOTICE = /Many people are signing in, please wait/;

/** The waits between attempts, held until the test lets each one end. */
let delays: number[];
let wake: (() => void)[];
const endWait = async (n: number) => {
  await waitFor(() => expect(wake).toHaveLength(n));
  wake[n - 1]?.();
};

beforeEach(() => {
  delays = [];
  wake = [];
  signInRetryTiming.random = () => 0.5;
  signInRetryTiming.sleep = (ms) =>
    new Promise<void>((resolve) => {
      delays.push(ms);
      wake.push(resolve);
    });
});
afterEach(() => {
  delete signInRetryTiming.random;
  delete signInRetryTiming.sleep;
});

const signIn = async (user: ReturnType<typeof renderApp>['user']) => {
  await user.type(await screen.findByLabelText('Email'), 'admin@alpha.test');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
};

describe('signing in while the server is busy', () => {
  it('says so, retries after jittered waits and signs in', async () => {
    mockSignedOut();
    let calls = 0;
    server.use(
      http.post(`${API}/auth/login`, () => {
        calls += 1;
        if (calls < 3) return busy();
        mockSignedIn(adminMe);
        return HttpResponse.json(adminMe);
      }),
    );
    const { user } = renderApp('/login');
    await signIn(user);
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await endWait(1);
    await endWait(2);
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(calls).toBe(3);
    // never sooner than the server's Retry-After, and spread by jitter
    expect(delays).toEqual([2500, 3000]);
  });

  it('gives up after three more attempts with an ordinary error', async () => {
    mockSignedOut();
    let calls = 0;
    server.use(
      http.post(`${API}/auth/login`, () => {
        calls += 1;
        return busy();
      }),
    );
    const { user } = renderApp('/login');
    await signIn(user);
    await endWait(1);
    await endWait(2);
    await endWait(3);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server is busy. Try again in a moment.',
    );
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(calls).toBe(4);
    // 2.5 + 3 + 5.5 s with the middle of the jitter: "about 10 seconds"
    expect(delays).toEqual([2500, 3000, 5500]);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('the two-step code step retries the same way, with the same code', async () => {
    mockSignedOut();
    const sent: unknown[] = [];
    server.use(
      http.post(`${API}/auth/login`, () => HttpResponse.json({ step: 'totp' }, { status: 202 })),
      http.post(`${API}/auth/mfa/verify`, async ({ request }) => {
        sent.push(await request.json());
        if (sent.length === 1) return busy();
        mockSignedIn(adminMe);
        return HttpResponse.json(adminMe);
      }),
    );
    const { user } = renderApp('/login');
    await signIn(user);
    await user.type(await screen.findByLabelText('Code from your authenticator app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    await endWait(1);
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(sent).toEqual([{ code: '123456' }, { code: '123456' }]);
  });
});
