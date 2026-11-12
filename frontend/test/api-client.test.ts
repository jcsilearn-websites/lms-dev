import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildQuery, setUnauthorizedHandler } from '../src/shared/api/client';
import { describeError, fieldErrors } from '../src/shared/api/errors';
import { API, errorBody, server } from './server';

afterEach(() => setUnauthorizedHandler(null));

describe('api()', () => {
  it('always sends the CSRF header, JSON, and credentials', async () => {
    let seen: Request | undefined;
    server.use(
      http.post(`${API}/things`, ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ ok: true });
      }),
    );
    const spy = vi.spyOn(globalThis, 'fetch');
    await api('/things', { method: 'POST', body: { a: 1 } });
    expect(seen?.headers.get('x-requested-with')).toBe('lms');
    expect(seen?.headers.get('content-type')).toBe('application/json');
    expect(await seen?.json()).toEqual({ a: 1 });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
    spy.mockRestore();
  });

  it('sends the CSRF header on GET too, and builds the query without empty values', async () => {
    let url = '';
    let header: string | null = null;
    server.use(
      http.get(`${API}/list`, ({ request }) => {
        url = request.url;
        header = request.headers.get('x-requested-with');
        return HttpResponse.json([]);
      }),
    );
    await api('/list', { query: { a: 'x', b: undefined, c: '', d: 0, e: false, f: null } });
    expect(new URL(url).search).toBe('?a=x&d=0&e=false');
    expect(header).toBe('lms');
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({ q: 'a b&c' })).toBe('?q=a+b%26c');
  });

  it('turns the standard error shape into an ApiError', async () => {
    server.use(
      http.get(`${API}/x`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_error',
              message: 'bad',
              requestId: 'r-1',
              details: [{ path: '/body/email', message: 'must match format' }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const err = await api('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation_error', requestId: 'r-1' });
    expect(fieldErrors(err)).toEqual({ email: 'must match format' });
  });

  it('maps a network failure to status 0 and a friendly message', async () => {
    server.use(http.get(`${API}/down`, () => HttpResponse.error()));
    const err = await api('/down').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network_error' });
    expect(describeError(err)).toMatch(/offline|cannot be reached/i);
  });

  it('calls the 401 handler for a signed-in call, but not for calls where 401 is an ordinary answer', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    server.use(
      http.get(`${API}/private`, () =>
        HttpResponse.json(errorBody('unauthenticated', 'Authentication required'), { status: 401 }),
      ),
    );
    await api('/private', { anonymousOk: true }).catch(() => undefined);
    expect(handler).not.toHaveBeenCalled();
    await api('/private').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for 204 and plain text for non-JSON', async () => {
    server.use(
      http.delete(`${API}/gone`, () => new HttpResponse(null, { status: 204 })),
      http.get(
        `${API}/csv`,
        () => new HttpResponse('a,b\n', { headers: { 'content-type': 'text/csv' } }),
      ),
    );
    expect(await api('/gone', { method: 'DELETE' })).toBeUndefined();
    expect(await api('/csv')).toBe('a,b\n');
  });
});

describe('describeError', () => {
  it('never shows server internals for a 500, only a reference', () => {
    const msg = describeError(
      new ApiError(500, 'internal_error', 'SELECT * FROM secrets', 'req-9'),
    );
    expect(msg).toContain('req-9');
    expect(msg).not.toContain('SELECT');
  });

  it('shows the server wording for conflicts and its own wording for rate limits and lockouts', () => {
    expect(describeError(new ApiError(409, 'last_admin', 'Keep one admin'))).toBe('Keep one admin');
    expect(
      describeError(
        new ApiError(429, 'FST_ERR_RATE_LIMIT', 'Rate limit exceeded, retry in 1 minute'),
      ),
    ).toMatch(/Too many requests/);
    expect(describeError(new ApiError(401, 'invalid_credentials', 'x'))).toBe(
      'Wrong email or password.',
    );
    expect(describeError(new Error('boom'))).toBe('Something went wrong. Try again.');
  });
});

describe('api() with retryBusy (503 busy, deadline receipts)', () => {
  const busyResponse = (receipt?: string) =>
    HttpResponse.json(errorBody('busy', 'Server busy'), {
      status: 503,
      headers: { 'retry-after': '2', ...(receipt ? { 'deadline-receipt': receipt } : {}) },
    });

  it('sends the same request again with the first receipt and honours Retry-After and the backoff', async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    server.use(
      http.post(`${API}/hand-in`, ({ request }) => {
        seen.push(request.headers.get('x-deadline-receipt'));
        n += 1;
        if (n === 1) return busyResponse('r-first');
        if (n === 2) return busyResponse('r-later');
        return HttpResponse.json({ ok: true });
      }),
    );
    const waits: number[] = [];
    const states: (unknown | null)[] = [];
    const res = await api<{ ok: boolean }>('/hand-in', {
      method: 'POST',
      body: {},
      retryBusy: {
        sleep: async (ms) => void waits.push(ms),
        random: () => 0,
        onBusy: (s) => states.push(s),
      },
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([null, 'r-first', 'r-first']);
    expect(waits).toEqual([2000, 2000]);
    expect(states.at(-1)).toBeNull();
    expect(states.some((s) => s !== null)).toBe(true);
  });

  it('freezes the body: what the caller changes while the request waits does not reach the retry', async () => {
    const bodies: unknown[] = [];
    let n = 0;
    server.use(
      http.post(`${API}/frozen`, async ({ request }) => {
        bodies.push(await request.json());
        n += 1;
        return n === 1 ? busyResponse('r') : HttpResponse.json({ ok: true });
      }),
    );
    const payload = { text: 'as pressed', fileIds: ['a'] };
    await api('/frozen', {
      method: 'POST',
      body: payload,
      retryBusy: {
        sleep: async () => {
          payload.text = 'edited while waiting';
          payload.fileIds.push('b');
        },
        random: () => 0,
      },
    });
    expect(bodies).toEqual([
      { text: 'as pressed', fileIds: ['a'] },
      { text: 'as pressed', fileIds: ['a'] },
    ]);
  });

  it('does not retry other errors, and gives up after maxAttempts', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/nope`, () => {
        calls += 1;
        return HttpResponse.json(errorBody('forbidden', 'No'), { status: 403 });
      }),
      http.post(`${API}/always-busy`, () => {
        calls += 1;
        return busyResponse();
      }),
    );
    const retry = { sleep: async () => {}, random: () => 0, maxAttempts: 2 };
    await expect(
      api('/nope', { method: 'POST', body: {}, retryBusy: retry }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toBe(1);
    await expect(
      api('/always-busy', { method: 'POST', body: {}, retryBusy: retry }),
    ).rejects.toMatchObject({ status: 503, code: 'busy' });
    expect(calls).toBe(1 + 3);
  });
});
