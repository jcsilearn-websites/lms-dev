/**
 * HTML for emails without injection: every interpolated value is escaped unless it is a SafeHtml produced by `html` itself.
 * Names, course and item titles, file names come from users: they are DATA, never markup.
 */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

function part(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return escapeHtml(String(v));
}

/** Tagged template: `html\`<p>${name}</p>\`` escapes `name`; nested html`` fragments are kept. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Only absolute http(s) URLs may become a link; anything else is refused (never `javascript:`). */
export function safeUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsafe link scheme');
  return u.toString();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters (to remove them) is the point
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** A header-safe single line: no CR / LF / control characters (header injection), collapsed spaces, bounded. */
export function oneLine(value: string, max = 200): string {
  const cleaned = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** A display name inside `"..." <address>`: no quotes, backslashes or angle brackets. */
export function displayName(value: string): string {
  return oneLine(value, 120).replace(/["\\<>]/g, '');
}

// ------------------------------------------------------------------ colour (WCAG contrast, like the frontend's)
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
export const NEUTRAL_BRAND = '#1e293b';
/** The college colour when white text on it passes AA (4.5:1), else a neutral dark slate. */
export function brandColor(color: string | null | undefined): string {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return NEUTRAL_BRAND;
  return contrast(color, '#ffffff') >= 4.5 ? color.toLowerCase() : NEUTRAL_BRAND;
}
