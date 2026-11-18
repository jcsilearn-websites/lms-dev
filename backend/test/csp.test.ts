import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTelemetry, installTelemetry, type Telemetry } from '../src/core/telemetry';
import { makeApp, type TestApp } from './app';

// Step 14a: what the API sends and receives about the Content-Security-Policy: its own strict policy on every response, and the
// report endpoint that browsers post violations to.

let t: TestApp;
let telemetry: Telemetry;

beforeAll(async () => {
  telemetry = createTelemetry({ serviceName: 'csp-test' });
  installTelemetry(telemetry);
  t = makeApp({ logLevel: 'warn' });
  await t.app.ready();
});
afterAll(async () => {
  installTelemetry(null);
  await telemetry.shutdown();
  await t.close();
});

const report = (payload: unknown, contentType = 'application/csp-report') =>
  t.app.inject({
    method: 'POST',
    url: '/api/csp-report',
    headers: { 'content-type': contentType }, // a browser sends neither Origin nor X-Requested-With
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

describe('API responses', () => {
  it('carry a policy that lets nothing load, plus the usual hardening headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).not.toMatch(/unsafe-/);
  });

  it('are not cacheable by default (no-store), while a route that chose its own policy keeps it', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/tenant/info',
      headers: { host: 'nowhere.localhost' },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const metrics = await t.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/csp-report', () => {
  it('accepts the legacy report-uri format and the Reporting API format, answers 204 and counts by directive', async () => {
    const legacy = await report({
      'csp-report': {
        'document-uri': 'https://x-college.example.edu/offerings/019abc/items/019def?token=SECRET',
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'inline',
        disposition: 'enforce',
      },
    });
    expect(legacy.statusCode).toBe(204);
    const modern = await report(
      [
        {
          type: 'csp-violation',
          body: {
            effectiveDirective: 'style-src-attr',
            blockedURL: 'inline',
            documentURL: 'https://x/y',
          },
        },
      ],
      'application/reports+json',
    );
    expect(modern.statusCode).toBe(204);
    const text = await telemetry.renderMetrics();
    expect(text).toMatch(/lms_csp_violations_total\{[^}]*directive="script-src-elem"[^}]*\} 1/);
    expect(text).toMatch(/lms_csp_violations_total\{[^}]*directive="style-src-attr"[^}]*\} 1/);
  });

  it('logs WITHOUT query strings, tokens or deep paths', async () => {
    t.logs.length = 0;
    await report({
      'csp-report': {
        'document-uri':
          'https://college.example.edu/offerings/019abc/items/019def?token=SECRETTOKEN',
        'blocked-uri': 'https://evil.example.com/steal/path/x?c=SECRETCOOKIE',
        'effective-directive': 'connect-src',
      },
    });
    const line = t.logs.find((l) => l.msg === 'csp violation');
    expect(line).toBeDefined();
    const text = JSON.stringify(line);
    expect(text).not.toMatch(/SECRETTOKEN|SECRETCOOKIE|019abc|019def|\/steal\/path/);
    expect(text).toContain('https://evil.example.com/steal');
    expect(text).toContain('connect-src');
  });

  it('ignores junk (not JSON, wrong shapes, a hostile directive name) without an error', async () => {
    expect((await report('not json at all')).statusCode).toBe(204);
    expect((await report({ nothing: 1 })).statusCode).toBe(204);
    expect(
      (await report({ 'csp-report': { 'effective-directive': 'x'.repeat(500) } })).statusCode,
    ).toBe(204);
    expect((await report('{}', 'application/json')).statusCode).toBe(204);
    expect(await telemetry.renderMetrics()).not.toContain(
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
  });

  it('refuses a body above 8 KB', async () => {
    const res = await report({ 'csp-report': { 'blocked-uri': 'x'.repeat(9000) } });
    expect(res.statusCode).toBe(413);
  });

  it('is public (no session needed) but is not a way to run an authenticated action: GET is a 404', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/csp-report' })).statusCode).toBe(404);
  });
});
