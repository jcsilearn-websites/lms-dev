// Where a demo college may be created or removed. The same rules as the load-test seed (loadtest/src/guard.mjs), because these
// commands write with the OWNER connection and `demo:reset` DELETES:
//   - never with NODE_ENV=production or on Cloud Run;
//   - only against a database host on the allowlist: this machine, plus DEMO_ALLOWED_HOSTS for a hosted demo database later
//     (exact names or "*.suffix"; a production host is never put there);
//   - only for a college whose slug starts with `demo-`.
// There is no switch that turns a check off.

export const DEFAULT_ALLOWED = ['localhost', '127.0.0.1', '::1', '*.localhost'];
export const DEMO_SLUG = /^demo-[a-z0-9]{2,20}(-[a-z0-9]{1,20})?$/;

export class DemoGuardError extends Error {}

function allowlist(env: Record<string, string | undefined>): string[] {
  const extra = (env.DEMO_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of extra) {
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(h) || h === '*.') {
      throw new DemoGuardError(`DEMO_ALLOWED_HOSTS: "${h}" is not a host name or a *.suffix`);
    }
  }
  return [...DEFAULT_ALLOWED, ...extra];
}

const allowed = (host: string, list: string[]) =>
  list.some((entry) =>
    entry.startsWith('*.')
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );

/** Throws unless the environment is not production, every database URL is on an allowed host and the slug is a demo slug. */
export function assertDemoTarget(
  slug: string,
  databaseUrls: (string | undefined)[],
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV === 'production') throw new DemoGuardError('refusing: NODE_ENV is production');
  if (env.K_SERVICE) throw new DemoGuardError('refusing: running on Cloud Run (K_SERVICE is set)');
  if (!DEMO_SLUG.test(slug)) {
    throw new DemoGuardError(`refusing: the slug must start with "demo-" (got "${slug}")`);
  }
  const list = allowlist(env);
  for (const url of databaseUrls) {
    if (!url) throw new DemoGuardError('refusing: DATABASE_URL and DATABASE_APP_URL must be set');
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      throw new DemoGuardError('refusing: a database URL is not a URL');
    }
    if (!allowed(host, list)) {
      throw new DemoGuardError(
        `refusing: the database host "${host}" is not on the allowlist (${list.join(', ')})`,
      );
    }
  }
}
