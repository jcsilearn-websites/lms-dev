// Where load may be sent. A load test is a denial of service against whatever answers, so every entry point (the seed, the runner) refuses:
//   - NODE_ENV=production in its own environment (a production shell must not run a load test by habit);
//   - a host that is not on the allowlist. The default allowlist is THIS machine: localhost, 127.0.0.1, ::1 and *.localhost. A staging
//     environment is added explicitly with LOADTEST_ALLOWED_HOSTS=host,host,*.suffix (exact names, or "*.suffix" for subdomains).
// There is no switch that turns the check off.

export const DEFAULT_ALLOWED = ['localhost', '127.0.0.1', '::1', '*.localhost'];

export function allowlistFrom(env = process.env) {
  const extra = (env.LOADTEST_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of extra) {
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(h) || h === '*' || h === '*.') {
      throw new Error(`LOADTEST_ALLOWED_HOSTS: "${h}" is not a host name or a *.suffix`);
    }
  }
  return [...DEFAULT_ALLOWED, ...extra];
}

export function hostAllowed(hostname, allowlist) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return allowlist.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".localhost"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === entry;
  });
}

/** Throws unless `url` (an http(s) or postgresql URL) points at an allowed host and the environment is not production. */
export function assertAllowedTarget(url, { what = 'target', env = process.env } = {}) {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      `refusing: NODE_ENV is production (a load test is never started from a production environment)`,
    );
  }
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`the ${what} is not a URL`);
  }
  const allow = allowlistFrom(env);
  if (!hostAllowed(hostname, allow)) {
    throw new Error(
      `refusing: the ${what} host "${hostname}" is not on the allowlist (${allow.join(', ')}). A staging host must be named in LOADTEST_ALLOWED_HOSTS; a production host must never be.`,
    );
  }
  return hostname;
}
