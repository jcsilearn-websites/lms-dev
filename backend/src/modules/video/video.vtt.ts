import { MAX_CAPTION_BYTES } from '../../contracts';

// WebVTT captions uploaded by instructors. The browser renders cues itself (<track>), but the file is still
// validated: the right header, UTF-8 text without control characters, a size limit and at least one cue.

export type VttResult = { ok: true; text: string } | { ok: false; message: string };

const TIMING =
  /^(?:\d{1,}:)?[0-5]?\d:[0-5]\d\.\d{3}\s+-->\s+(?:\d{1,}:)?[0-5]?\d:[0-5]\d\.\d{3}(?:\s.*)?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the check for control characters
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validateWebVtt(raw: string): VttResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CAPTION_BYTES) {
    return { ok: false, message: 'The caption file is larger than 256 KB' };
  }
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) {
    return { ok: false, message: 'This is not a WebVTT file (it must start with WEBVTT)' };
  }
  if (CONTROL.test(text)) {
    return { ok: false, message: 'The caption file contains characters that are not allowed' };
  }
  let cues = 0;
  for (const line of text.split('\n')) {
    if (TIMING.test(line)) cues++;
    if (cues > 20_000) return { ok: false, message: 'The caption file has too many cues' };
  }
  if (cues === 0) return { ok: false, message: 'The caption file has no cues' };
  return { ok: true, text: text.endsWith('\n') ? text : `${text}\n` };
}
