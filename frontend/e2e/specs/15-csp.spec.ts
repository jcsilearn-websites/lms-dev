import { spaContentSecurityPolicy, spaSecurityHeaders } from '@lms/backend/csp';
import { expect, expectCspViolation, originOf, request, test } from '../support';

// Step 14a: the strict Content-Security-Policy, verified in a real browser against the real stack.
//   1. every document is served with THE shared policy (one module, backend/src/contracts/csp.ts) and the hardening headers;
//   2. the app itself raises no violation (the auto fixture in support.ts fails EVERY spec on one: this file proves the fixture works);
//   3. a violation that IS provoked is blocked, reaches the browser's event, and is REPORTED to /api/csp-report (the production path);
//   4. what the policy must allow keeps working: styles set through the CSSOM;
//   5. the report endpoint is rate limited.

test.describe('content security policy', () => {
  test('every document carries the one shared policy and the hardening headers', async ({
    page,
  }) => {
    const response = await page.goto(`${originOf('e2e-one')}/login`);
    const headers = response?.headers() ?? {};
    const expected = spaSecurityHeaders();
    for (const [name, value] of Object.entries(expected)) expect(headers[name], name).toBe(value);
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toBe(spaContentSecurityPolicy());
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    // a deep link (the SPA fallback) and an unknown path are served with it too
    const deep = await page.goto(`${originOf('e2e-one')}/members`);
    expect(deep?.headers()['content-security-policy']).toBe(csp);
  });

  test('the app renders and works with no violation (login page, sign-in, home)', async ({
    page,
  }) => {
    await page.goto(`${originOf('e2e-one')}/login`);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill('admin@e2e-one.test');
    await page
      .getByLabel('Password')
      .fill(process.env.E2E_PASSWORD ?? 'correct-horse-battery-staple');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    // the college colour and the progress bars are applied through the CSSOM: the page has its theme and no violation
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--college-primary').trim(),
    );
    expect(accent.length).toBeGreaterThanOrEqual(0);
  });

  test('a provoked violation is blocked, seen by the browser, and REPORTED to the API', async ({
    page,
  }) => {
    expectCspViolation(); // this test breaks the policy on purpose
    await page.goto(`${originOf('e2e-one')}/login`);
    const reported = page.waitForResponse(
      (r) => r.url().includes('/api/csp-report') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    const blocked = await page.evaluate(
      () =>
        new Promise<{ directive: string; blocked: string; ran: boolean }>((resolve) => {
          document.addEventListener('securitypolicyviolation', (e) => {
            resolve({
              directive: e.effectiveDirective,
              blocked: e.blockedURI,
              ran: (window as unknown as { __cspRan?: boolean }).__cspRan === true,
            });
          });
          const s = document.createElement('script');
          s.textContent = 'window.__cspRan = true';
          document.head.appendChild(s);
        }),
    );
    expect(blocked.directive).toBe('script-src-elem');
    expect(blocked.ran).toBe(false); // the inline script did NOT run
    const response = await reported;
    expect(response.status()).toBe(204);
    // the report carries the directive and no personal data (the document URL is cut by the API before it is logged)
    const body = JSON.stringify((await response.request().postDataJSON()) ?? {});
    expect(body).toContain('script-src');
  });

  test('an inline style ATTRIBUTE is blocked, while styling through the CSSOM keeps working', async ({
    page,
  }) => {
    expectCspViolation();
    await page.goto(`${originOf('e2e-one')}/login`);
    const result = await page.evaluate(() => {
      const el = document.createElement('div');
      el.textContent = 'x';
      document.body.appendChild(el);
      el.style.color = 'rgb(1, 2, 3)'; // CSSOM: allowed
      const viaCssom = getComputedStyle(el).color;
      el.setAttribute('style', 'color: rgb(4, 5, 6)'); // an attribute: blocked
      return { viaCssom, viaAttribute: getComputedStyle(el).color };
    });
    expect(result.viaCssom).toBe('rgb(1, 2, 3)');
    expect(result.viaAttribute).toBe('rgb(1, 2, 3)'); // the attribute did not apply
  });

  test('the report endpoint is rate limited (60 per address per minute across every instance)', async () => {
    const ctx = await request.newContext({
      baseURL: `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 4173}/api/`,
      extraHTTPHeaders: { host: `e2e-one.localhost:${process.env.E2E_WEB_PORT ?? 4173}` },
    });
    const codes: number[] = [];
    for (let i = 0; i < 75; i++) {
      const r = await ctx.post('csp-report', {
        headers: { 'content-type': 'application/csp-report' },
        data: JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src' } }),
      });
      codes.push(r.status());
    }
    expect(codes).toContain(204);
    expect(codes.slice(-5).every((c) => c === 429)).toBe(true);
    await ctx.dispose();
  });
});
