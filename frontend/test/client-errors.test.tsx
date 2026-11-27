import type { ErrorReport } from '@lms/backend/scrub';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrashPage, ErrorBoundary } from '../src/app/ErrorBoundary';
import { ApiError } from '../src/shared/api/client';
import {
  createErrorReporter,
  errorReporter,
  installGlobalErrorHandlers,
  isChunkError,
} from '../src/shared/errors/clientErrors';

// The crash path: what the reporter sends (scrubbed, rate limited, never an API failure), and what the error boundary shows.

function reporter(over: { now?: () => number } = {}) {
  const sent: ErrorReport[] = [];
  const r = createErrorReporter({
    send: (report) => sent.push(report),
    route: () => '/offerings/0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07/items/12',
    build: 'b-test',
    ...over,
  });
  return { r, sent };
}

describe('the reporter', () => {
  it('sends a SCRUBBED report: no e-mail address, id, token, host, query or long number leaves the browser, and the route is a template', () => {
    const { r, sent } = reporter();
    const error = new Error(
      'Cannot save for jane.doe@college.edu (offering 0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07) register 2026123456 token=SECRETVALUE',
    );
    error.stack = `Error: x\n    at save (https://c-college.example.edu:8443/assets/ExamPage-AbC.js:10:20?sid=COOKIE)\n    at jane@x.org`;
    expect(r.report('render', error)).toBe(true);
    const text = JSON.stringify(sent[0]);
    expect(text).not.toMatch(
      /jane|college\.edu|c-college|0190a5c2|2026123456|SECRETVALUE|COOKIE|8443/,
    );
    expect(sent[0]).toMatchObject({
      v: 1,
      kind: 'render',
      route: '/offerings/:id/items/:n',
      build: 'b-test',
    });
    expect(sent[0]?.stack).toContain('/assets/ExamPage-AbC.js:10:20');
  });

  it('reports each distinct error ONCE, at most 5 a minute and 20 a page', () => {
    let t = 0;
    const { r, sent } = reporter({ now: () => t });
    expect(r.report('unhandled', new Error('same'))).toBe(true);
    expect(r.report('unhandled', new Error('same'))).toBe(false); // the same error again
    for (let i = 0; i < 10; i++) r.report('unhandled', new Error(`different ${i}`));
    expect(sent).toHaveLength(5); // the per-minute ceiling
    t = 61_000;
    for (let i = 0; i < 30; i++) {
      r.report('unhandled', new Error(`later ${i}`));
      t += 61_000;
    }
    expect(sent).toHaveLength(20); // the per-page ceiling
  });

  it('never reports failures of the API itself (offline, 4xx, 5xx), benign browser noise, or an error with no message', () => {
    const { r, sent } = reporter();
    expect(r.report('rejection', new ApiError(0, 'network', 'offline'))).toBe(false);
    expect(r.report('rejection', new ApiError(500, 'internal_error', 'x'))).toBe(false);
    expect(
      r.report(
        'unhandled',
        new Error('ResizeObserver loop completed with undelivered notifications.'),
      ),
    ).toBe(false);
    expect(r.report('unhandled', new Error(''))).toBe(false);
    expect(r.report('rejection', undefined)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('a failed lazy chunk (a release replaced the files) is reported as kind "chunk"', () => {
    const { r, sent } = reporter();
    const error = new TypeError(
      'Failed to fetch dynamically imported module: https://x.example.edu/assets/Page-ab12.js',
    );
    expect(isChunkError(error)).toBe(true);
    r.report('unhandled', error);
    expect(sent[0]?.kind).toBe('chunk');
    expect(sent[0]?.message).toContain('/assets/Page-ab12.js');
    expect(sent[0]?.message).not.toContain('x.example.edu');
  });

  it('never throws into the crash handler, even when sending fails', () => {
    const r = createErrorReporter({
      send: () => {
        throw new Error('network');
      },
    });
    expect(() => r.report('render', new Error('boom'))).not.toThrow();
  });
});

describe('what goes over the wire', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the shared reporter posts to /api/client-errors with the two CSRF headers, keepalive, and a body the API accepts (closed shape, under 4 KB)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(null, { status: 204 });
    });
    errorReporter.report('render', new Error(`wire test ${Math.random()} for jane@x.org`));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('/api/client-errors');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.keepalive).toBe(true);
    expect(call?.init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-requested-with': 'lms',
    });
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(
      Object.keys(body)
        .sort()
        .filter((k) => !['stack', 'route', 'build'].includes(k)),
    ).toEqual(['kind', 'message', 'v']);
    expect(String(call?.init.body).length).toBeLessThan(4096);
    expect(String(call?.init.body)).not.toContain('jane');
  });

  it('window errors and unhandled rejections are reported', () => {
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)));
      return new Response(null, { status: 204 });
    });
    const target = new EventTarget() as unknown as Window;
    installGlobalErrorHandlers(target);
    target.dispatchEvent(
      Object.assign(new Event('error'), {
        error: new Error(`window error ${Math.random()}`),
        message: 'x',
      }),
    );
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), {
        reason: new Error(`rejected ${Math.random()}`),
      }),
    );
    expect(sent.map((s) => (s as { kind: string }).kind)).toEqual(['unhandled', 'rejection']);
  });
});

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

describe('the error boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an alert with a reload button instead of a white screen, and reports once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const posted: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      posted.push(String((init as RequestInit).body));
      return new Response(null, { status: 204 });
    });
    render(
      <ErrorBoundary>
        <Boom message={`render failed ${Math.random()}`} />
      </ErrorBoundary>,
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0] as string)).toMatchObject({ kind: 'render' });
  });

  it('reloads the page when asked, and says so plainly for a failed chunk (a new version)', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, pathname: '/' },
    });
    const user = userEvent.setup();
    render(
      <CrashPage
        error={new TypeError('Failed to fetch dynamically imported module: /assets/x.js')}
      />,
    );
    expect(screen.getByRole('heading', { name: 'A new version is available' })).toBeInTheDocument();
    expect(screen.getByText(/Your work in an exam is kept in this browser/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('children that do not fail are shown untouched', () => {
    render(
      <ErrorBoundary>
        <p>all fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all fine')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
