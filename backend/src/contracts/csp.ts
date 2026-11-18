// THE ONE CONTENT-SECURITY-POLICY (step 14a, docs/adr/0023-csp-and-key-rotation.md). Shared by everything that serves the SPA:
// the static server of E2E / Lighthouse (frontend/scripts/serve.mjs), the production gateway or CDN (see README "Production routing"),
// and the tests that pin it. Leaf file: no imports. Node can load it directly (type stripping): `@lms/backend/csp`.
//
// No 'unsafe-inline', no 'unsafe-eval', no nonces: the Vite build emits only external scripts and the app sets every style through
// the CSSOM (element.style / CSS custom properties, which CSP allows), never through a style="" attribute or a <style> element.
// A library that starts injecting <style> elements fails the E2E suite on the violation report: fix the library's use, do not
// loosen this policy.

/** Where browsers post violation reports (a rate-limited, unauthenticated endpoint; see modules/ops). */
export const CSP_REPORT_PATH = '/api/csp-report';

export interface SpaHeaderOptions extends SpaCspOptions {
  /**
   * Leave out Cross-Origin-Opener-Policy. PRODUCTION NEVER SETS THIS. It exists only because COOP makes Lighthouse lose the main frame
   * (every performance score 0): `pnpm lighthouse` serves with SERVE_OMIT_COOP=1 (frontend/scripts/serve.mjs), and nothing else may.
   */
  omitCoop?: boolean;
}

export interface SpaCspOptions {
  /** report endpoint (default CSP_REPORT_PATH); null = no reporting */
  reportPath?: string | null;
}

export function spaContentSecurityPolicy(opts: SpaCspOptions = {}): string {
  const report = opts.reportPath === undefined ? CSP_REPORT_PATH : opts.reportPath;
  const directives = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    // hls.js runs its transmuxer in a blob: worker; the service worker is a same-origin script
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  if (report) directives.push(`report-uri ${report}`);
  return directives.join('; ');
}

/** The policy of API responses (JSON, files): nothing may load or run. */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The security headers every response of the SPA must carry (the gateway sets exactly these). */
export function spaSecurityHeaders(opts: SpaHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': spaContentSecurityPolicy(opts),
    // browsers ignore it over plain http (E2E, local development); in production every college host is https only
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    // pages that play video override this with no-referrer (their playback link is a credential)
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (!opts.omitCoop) headers['cross-origin-opener-policy'] = 'same-origin';
  return headers;
}
