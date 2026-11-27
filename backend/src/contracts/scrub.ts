// Scrubbing of text that leaves a browser as an ERROR REPORT (step 14b-2 part D). ONE implementation, used twice: the browser scrubs before it sends
// (so nothing personal ever travels), and the API scrubs again before it logs (it never trusts the client). Pure, no imports, leaf file: the SPA
// loads it through `@lms/backend/scrub`.
//
// What goes: e-mail addresses, UUIDs, tokens and keys (JWT-like strings, any run of 24+ letters / digits / `_` / `-`, `token=...` pairs), long digit
// runs (phone, register and employee numbers), and the HOST, QUERY and FRAGMENT of every URL (a URL keeps only its path). A report says WHAT broke and
// WHERE in the code, never WHO was using it.

export const REPORT_LIMITS = { message: 300, stack: 1500, route: 100, build: 40 } as const;

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"<>\]]+/gi;
const EMAIL_RE = /[^\s@<>()[\]"',;:/\\]+@[^\s@<>()[\]"',;/\\]+\.[A-Za-z]{2,}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const SECRET_PAIR_RE =
  /\b(token|secret|password|passwd|apikey|api_key|session|sid|authorization|cookie)\b\s*[=:]\s*[^\s,;&)"']+/gi;
const BEARER_RE = /\bbearer\s+[^\s,;)"']+/gi;
const UUID_ONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TOKEN_RE = /[A-Za-z0-9_-]{24,}/g;
const LONG_DIGITS_RE = /\d{6,}/g;

/** A URL reduced to its path (no host, no query, no fragment). A stack frame's `:line:column` belongs to the path and stays. */
function pathOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*(\/[^?#\s]*)?/i.exec(url);
  return m ? (m[1] ?? '/') : '';
}

/** Text safe to log and to send: scrubbed, then cut to `max` characters. Anything that is not a string becomes ''. */
export function scrubText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  let s = input.slice(0, max * 4); // bound the work on a huge input before the regular expressions run
  s = s.replace(URL_RE, (u) => pathOfUrl(u));
  s = s.replace(EMAIL_RE, '[email]');
  s = s.replace(JWT_RE, '[token]');
  s = s.replace(UUID_RE, '[id]');
  s = s.replace(SECRET_PAIR_RE, (_m, name: string) => `${name.toLowerCase()}=[redacted]`);
  s = s.replace(BEARER_RE, 'bearer [redacted]');
  s = s.replace(LONG_TOKEN_RE, '[token]');
  s = s.replace(LONG_DIGITS_RE, '[n]');
  return s.slice(0, max);
}

const SEGMENT_WORD = /^[a-z][a-z-]{0,30}$/;

/**
 * A page path as a ROUTE TEMPLATE: `/offerings/0190.../items/12` becomes `/offerings/:id/items/:n`. Words stay (they are our routes), everything else is
 * an id or unknown and is replaced; query and fragment are dropped.
 */
export function scrubRoute(input: unknown): string {
  if (typeof input !== 'string') return '';
  const path = (input.split(/[?#]/)[0] ?? '').slice(0, 400);
  const parts = path.split('/').filter(Boolean).slice(0, 8);
  const out = parts.map((p) => {
    if (UUID_ONE.test(p)) return ':id';
    if (/^\d+$/.test(p)) return ':n';
    if (SEGMENT_WORD.test(p)) return p;
    if (/^[A-Za-z0-9_-]{16,}$/.test(p)) return ':token';
    return ':x';
  });
  return `/${out.join('/')}`.slice(0, REPORT_LIMITS.route);
}

export const REPORT_KINDS = ['render', 'unhandled', 'rejection', 'chunk'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ErrorReport {
  v: 1;
  kind: ReportKind;
  message: string;
  stack?: string | undefined;
  route?: string | undefined;
  build?: string | undefined;
}

/** The scrubbed form of any report (the client sends this; the server recomputes it from what it received). */
export function scrubReport(raw: {
  kind: ReportKind;
  message?: unknown;
  stack?: unknown;
  route?: unknown;
  build?: unknown;
}): ErrorReport {
  const stack = scrubText(raw.stack, REPORT_LIMITS.stack);
  const route = scrubRoute(raw.route);
  const build = scrubText(raw.build, REPORT_LIMITS.build).replace(/[^A-Za-z0-9._-]/g, '');
  return {
    v: 1,
    kind: raw.kind,
    message: scrubText(raw.message, REPORT_LIMITS.message),
    ...(stack ? { stack } : {}),
    ...(route ? { route } : {}),
    ...(build ? { build } : {}),
  };
}
