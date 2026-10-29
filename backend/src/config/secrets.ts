export function passwordFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}

/** Replace every occurrence of each secret in text. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}
