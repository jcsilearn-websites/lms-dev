// File names that come from people end up in two dangerous places: inside a ZIP (zip-slip: "../../x" written outside
// the folder the reader extracts to) and in a Content-Disposition header. Everything written there goes through
// `safeFileName`. The stored display name is kept as the person typed it (minus control characters); only what leaves
// the system is rewritten.

const MAX_NAME = 120;
const MAX_EXTENSION = 16;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Characters that are control, bidirectional-override, zero-width or line-breaking: invisible, so they can make
// "report.pdf" look like something else (RTL override) or hide a name. Removed, never replaced.
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
// Path separators and the characters Windows refuses in a name; each becomes "_".
const FORBIDDEN = /[\\/:*?"<>|]/g;

/** `name` cut to `max` code points (never in the middle of a surrogate pair). */
function cut(name: string, max: number): string {
  const chars = [...name];
  return chars.length <= max ? name : chars.slice(0, max).join('');
}

/**
 * A name that is safe as ONE path segment on every platform and in a header: no separators, no "..", no control or
 * invisible characters, no leading dots or spaces (hidden files), no trailing dots or spaces (Windows drops them),
 * not a Windows device name (CON, NUL, COM1 ...), at most 120 characters with the extension kept. Never empty.
 */
export function safeFileName(raw: string, fallback = 'file'): string {
  let name = raw.normalize('NFC').replace(INVISIBLE, '').replace(FORBIDDEN, '_');
  // ".." (and longer runs of dots) can only mean a path climb or a trick: one dot is a normal name part
  name = name.replace(/\.{2,}/g, '.');
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name === '') return fallback;

  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot) : '';
  if ([...ext].length > MAX_EXTENSION + 1) ext = cut(ext, MAX_EXTENSION + 1);
  stem = cut(stem, MAX_NAME - [...ext].length).replace(/[.\s]+$/, '');
  if (stem === '') stem = fallback;
  // a device name is reserved with ANY extension ("CON.pdf") and with trailing text after a dot ("aux.tar.gz")
  if (RESERVED.test(stem.split('.')[0] ?? '')) stem = `_${stem}`;
  return `${stem}${ext}`;
}

/** Makes `name` unique inside one folder (case-insensitively, as Windows and macOS extract): "a.pdf", "a (2).pdf". */
export function uniqueName(used: Set<string>, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}
