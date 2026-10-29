/** Hosts that mean "this machine": the only ones where TLS may be off and a local database is assumed. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.includes(hostname.toLowerCase());
}

/** The host of a postgres URL, or null when it is not a URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
