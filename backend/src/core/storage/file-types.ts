// What may be uploaded, and how it is served. The server decides the type: the extension names the kind, the
// first bytes (magic numbers) must agree with it, and the stored content type is OUR canonical one, never
// what the browser claimed. Anything not listed here is refused (no html, svg, scripts or executables).

export interface FileKind {
  /** canonical media type stored and sent */
  mime: string;
  extensions: readonly string[];
  /** Shown in the browser tab instead of downloaded: only formats a browser renders without running code. */
  inline: boolean;
  /** The first bytes of the file (up to 8 KB) look like this kind. */
  matches(head: Buffer): boolean;
}

const startsWith = (head: Buffer, bytes: readonly number[], offset = 0) =>
  head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Plain text: no NUL byte and valid UTF-8 (a multi-byte character cut by the 8 KB window is tolerated). */
function isText(head: Buffer): boolean {
  if (head.includes(0)) return false;
  const tail = head.length >= 8192 ? 3 : 0;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - tail));
    return true;
  } catch {
    return false;
  }
}

const zip = (head: Buffer) => startsWith(head, [0x50, 0x4b, 0x03, 0x04]);

export const FILE_KINDS: readonly FileKind[] = [
  {
    mime: 'application/pdf',
    extensions: ['pdf'],
    inline: true,
    matches: (h) => startsWith(h, ascii('%PDF-')),
  },
  {
    mime: 'image/png',
    extensions: ['png'],
    inline: true,
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mime: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    inline: true,
    matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  },
  {
    mime: 'image/gif',
    extensions: ['gif'],
    inline: false,
    matches: (h) => startsWith(h, ascii('GIF87a')) || startsWith(h, ascii('GIF89a')),
  },
  {
    mime: 'image/webp',
    extensions: ['webp'],
    inline: false,
    matches: (h) => startsWith(h, ascii('RIFF')) && startsWith(h, ascii('WEBP'), 8),
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    inline: false,
    matches: zip,
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    inline: false,
    matches: zip,
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx'],
    inline: false,
    matches: zip,
  },
  { mime: 'application/zip', extensions: ['zip'], inline: false, matches: zip },
  { mime: 'text/plain', extensions: ['txt'], inline: false, matches: isText },
  { mime: 'text/csv', extensions: ['csv'], inline: false, matches: isText },
  {
    mime: 'video/mp4',
    extensions: ['mp4'],
    inline: false,
    matches: (h) => startsWith(h, ascii('ftyp'), 4),
  },
  {
    mime: 'audio/mpeg',
    extensions: ['mp3'],
    inline: false,
    matches: (h) => startsWith(h, ascii('ID3')) || (h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0),
  },
];

/** The lower-case extension of a file name ('' when it has none). */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  // a name that is only an extension (".pdf") has none
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** The kind an extension names, or null when the extension is not allowed. */
export function kindForName(name: string): FileKind | null {
  const ext = extensionOf(name);
  return FILE_KINDS.find((k) => k.extensions.includes(ext)) ?? null;
}

/** The kind of a file, or null: the extension must be allowed AND the content must look like it. */
export function classify(name: string, head: Buffer): FileKind | null {
  const kind = kindForName(name);
  return kind?.matches(head) ? kind : null;
}

/** A display name that is safe to store and to put in a header: the last path segment, no control characters. */
export function cleanFileName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, 255);
}

/** Content-Disposition: inline only for the formats a browser renders without running code; the name is encoded. */
export function contentDisposition(name: string, inline: boolean): string {
  const safe = cleanFileName(name) || 'file';
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
