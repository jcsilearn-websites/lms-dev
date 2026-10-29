/**
 * The page to return to after signing in. Only an in-app absolute path is accepted: anything else
 * (another origin, protocol-relative //evil.test, a backslash trick, javascript:) is dropped, so the
 * ?redirect= parameter can not be used as an open redirect.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return undefined;
  if (value.startsWith('/login')) return undefined;
  return value;
}
