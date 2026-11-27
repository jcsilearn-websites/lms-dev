import { describe, expect, it } from 'vitest';
import { REPORT_LIMITS, scrubReport, scrubRoute, scrubText } from '../src/contracts/scrub';

// The scrubber is the ONE place that decides what may leave a browser as an error report and be logged by the API (contracts/scrub.ts).

describe('scrubText', () => {
  const clean = (s: string, max = 500) => scrubText(s, max);

  it('removes e-mail addresses wherever they sit', () => {
    expect(clean('Failed for jane.doe+x@college.example.edu while saving')).toBe(
      'Failed for [email] while saving',
    );
    expect(clean('user=<bob@x.io>, retry')).not.toContain('bob');
    expect(clean('a@b.co and c@d.org')).toBe('[email] and [email]');
  });

  it('removes UUIDs, JWT-like strings, long tokens and secret pairs', () => {
    const id = '0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07';
    expect(clean(`offering ${id} not found`)).toBe('offering [id] not found');
    expect(clean('Bearer abcdef0123456789abcdef')).toBe('bearer [redacted]');
    expect(clean('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_nature')).toBe('[token]');
    expect(
      clean('playback /api/video/play/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA/asset/master.m3u8'),
    ).not.toMatch(/Zm9v/);
    expect(clean('password=hunter2 and token: abc123 sid=xyz')).toBe(
      'password=[redacted] and token=[redacted] sid=[redacted]',
    );
    expect(clean('apiKey=ABC')).toContain('[redacted]');
  });

  it('removes long numbers (phone, register, employee numbers) but keeps short ones', () => {
    expect(clean('register 2026123456 phone +919876543210')).toBe('register [n] phone +[n]');
    expect(clean('line 12 column 345')).toBe('line 12 column 345');
    expect(clean('status 500 after 30000 ms')).toBe('status 500 after 30000 ms');
  });

  it('keeps only the PATH of a URL: no host, no query, no fragment, and the stack position survives', () => {
    expect(
      clean('GET https://college.example.edu/api/offerings?token=SECRET&x=1#frag failed'),
    ).toBe('GET /api/offerings failed');
    expect(clean('at https://a-college.example.edu:8443/assets/ExamPage-Cx9d.js:12:34')).toBe(
      'at /assets/ExamPage-Cx9d.js:12:34',
    );
    expect(
      clean(
        'Failed to fetch dynamically imported module: http://x-college.localhost:4173/assets/Page-ab12.js',
      ),
    ).toBe('Failed to fetch dynamically imported module: /assets/Page-ab12.js');
    expect(clean('see https://evil.example/?email=jane@x.org')).not.toMatch(/evil|jane/);
  });

  it('cuts to the limit, and anything that is not a string becomes empty', () => {
    expect(scrubText('word '.repeat(2000), REPORT_LIMITS.message)).toHaveLength(
      REPORT_LIMITS.message,
    );
    expect(scrubText(undefined, 10)).toBe('');
    expect(scrubText({ a: 1 }, 10)).toBe('');
    expect(scrubText(42, 10)).toBe('');
  });

  it('is not defeated by splitting, case, or odd separators', () => {
    expect(clean('JANE@COLLEGE.EDU')).toBe('[email]');
    expect(clean('mail jane@college.edu,bob@college.edu;carol@college.edu')).not.toMatch(
      /jane|bob|carol/,
    );
    expect(clean('Token = abcdef')).toBe('token=[redacted]');
  });

  it('finishes quickly on adversarial input (no catastrophic backtracking)', () => {
    const t0 = performance.now();
    scrubText(`${'a'.repeat(5000)}@${'b.'.repeat(2000)}`, 1500);
    scrubText(`http://${'a'.repeat(5000)}`, 1500);
    scrubText('-'.repeat(8000), 1500);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('scrubRoute', () => {
  it('turns a page path into a route template', () => {
    expect(
      scrubRoute(
        '/offerings/0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07/items/0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c08?x=1#y',
      ),
    ).toBe('/offerings/:id/items/:id');
    expect(scrubRoute('/members/12345/profile')).toBe('/members/:n/profile');
    expect(scrubRoute('/unsubscribe/Zm9vYmFyYmF6cXV4MTIzNDU2')).toBe('/unsubscribe/:token');
    expect(scrubRoute('/reset-password')).toBe('/reset-password');
    expect(scrubRoute('/jane.doe@x.org/Weird Thing')).toBe('/:x/:x');
    expect(scrubRoute(null)).toBe('');
  });
});

describe('scrubReport', () => {
  it('scrubs every field, keeps the kind, and drops what it cannot trust', () => {
    const r = scrubReport({
      kind: 'render',
      message: 'Cannot read x of jane@college.edu',
      stack: 'Error\n    at f (https://c.example.edu/assets/index-AbC.js:1:2)',
      route: '/offerings/0190a5c2-7b1e-7c3a-9d41-5f8e2a6b1c07',
      build: 'b-12.ab<script>',
    });
    expect(r).toEqual({
      v: 1,
      kind: 'render',
      message: 'Cannot read x of [email]',
      stack: 'Error\n    at f (/assets/index-AbC.js:1:2)',
      route: '/offerings/:id',
      build: 'b-12.abscript',
    });
    expect(Object.keys(scrubReport({ kind: 'chunk', message: 'm' }))).toEqual([
      'v',
      'kind',
      'message',
    ]);
  });
});
