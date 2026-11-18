import { describe, expect, it } from 'vitest';
import {
  API_CONTENT_SECURITY_POLICY,
  CSP_REPORT_PATH,
  spaContentSecurityPolicy,
  spaSecurityHeaders,
} from '../src/contracts/csp';

// Step 14a: the ONE Content-Security-Policy. The policy is data; these tests pin its shape so nobody loosens it by accident.

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  ) as Record<string, string[]>;

describe('SPA policy', () => {
  const csp = spaContentSecurityPolicy();
  const d = directives(csp);

  it('has no unsafe-inline, no unsafe-eval, no wildcard, no remote origin, no nonce or hash allowance', () => {
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic/);
    expect(csp).not.toMatch(/\*|https?:/);
    expect(csp).not.toMatch(/'nonce-|'sha(256|384|512)-/);
  });

  it('starts from nothing and opens only what the app needs, all on its own origin', () => {
    expect(d['default-src']).toEqual(["'none'"]);
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['style-src']).toEqual(["'self'"]);
    expect(d['connect-src']).toEqual(["'self'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:']);
    expect(d['media-src']).toEqual(["'self'", 'blob:']); // hls.js feeds the <video> through a MediaSource
    expect(d['worker-src']).toEqual(["'self'", 'blob:']); // the service worker, and hls.js's transmuxer
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'none'"]);
    expect(d['form-action']).toEqual(["'self'"]);
  });

  it('reports violations to our own endpoint (or nowhere when asked)', () => {
    expect(d['report-uri']).toEqual([CSP_REPORT_PATH]);
    expect(spaContentSecurityPolicy({ reportPath: null })).not.toContain('report-uri');
  });

  it('the headers a gateway must send carry it, plus nosniff, a referrer policy and COOP', () => {
    const h = spaSecurityHeaders();
    expect(h['content-security-policy']).toBe(csp);
    expect(h['strict-transport-security']).toMatch(/^max-age=\d{7,}/);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('same-origin');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    // only the explicit local-Lighthouse flag leaves it out (it makes Lighthouse score every page 0)
    const lighthouse = spaSecurityHeaders({ omitCoop: true });
    expect(lighthouse['cross-origin-opener-policy']).toBeUndefined();
    expect(lighthouse['content-security-policy']).toBe(csp);
    expect(h['permissions-policy']).toContain('camera=()');
  });
});

describe('API policy', () => {
  it('lets nothing load or run', () => {
    expect(API_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});
