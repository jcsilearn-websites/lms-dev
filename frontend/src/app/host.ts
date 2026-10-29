/** 'admin' on admin.<domain> (platform area), 'tenant' on <slug>.<domain>. Decided once from the hostname. */
export type HostKind = 'admin' | 'tenant';

export function hostKindOf(hostname: string): HostKind {
  return hostname.toLowerCase().split('.')[0] === 'admin' ? 'admin' : 'tenant';
}

export const hostKind: HostKind = hostKindOf(window.location.hostname);
