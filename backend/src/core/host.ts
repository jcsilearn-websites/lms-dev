export type HostInfo =
  | { kind: 'tenant'; slug: string; portSuffix: string }
  | { kind: 'admin'; portSuffix: string }
  | { kind: 'none' };

const SLUG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Classifies the request Host: `<slug>.<APP_BASE_DOMAIN>` is a tenant, `admin.<APP_BASE_DOMAIN>` is the
 * platform admin area, anything else (bare domain, Cloud Run URL, IP) carries no tenant context.
 * Never trust the result for building links beyond slug + numeric port.
 */
export function parseHost(hostHeader: string | undefined, baseDomain: string): HostInfo {
  if (!hostHeader) return { kind: 'none' };
  const lower = hostHeader.trim().toLowerCase();
  const m = /^([a-z0-9.-]+)(:\d{1,5})?$/.exec(lower);
  if (!m) return { kind: 'none' };
  const hostname = m[1] as string;
  const portSuffix = m[2] ?? '';
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return { kind: 'none' };
  const label = hostname.slice(0, -suffix.length);
  if (label === 'admin') return { kind: 'admin', portSuffix };
  if (!SLUG.test(label)) return { kind: 'none' };
  return { kind: 'tenant', slug: label, portSuffix };
}

/**
 * Origin for links in emails: scheme + validated slug (or "admin") + the configured base domain
 * (+ numeric port). Never echoes arbitrary Host header text, so a forged Host cannot poison links.
 */
export function buildOrigin(info: HostInfo, baseDomain: string, secure: boolean): string | null {
  if (info.kind === 'none') return null;
  const label = info.kind === 'admin' ? 'admin' : info.slug;
  return `${secure ? 'https' : 'http'}://${label}.${baseDomain}${info.portSuffix}`;
}
