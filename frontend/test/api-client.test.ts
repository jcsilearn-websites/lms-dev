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
