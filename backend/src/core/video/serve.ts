import type { AssetRef } from './provider';

// What a playback token may fetch, and how it is served. The path after the token is matched against an allow
// list; anything else is a 404, so a token can never reach another asset's files or the original upload.

export interface Served {
  /** object key below the asset prefix */
  key: string;
  contentType: string;
  /** Cache-Control: playlists are cheap and may change when the video is replaced, segments never change */
  cacheControl: string;
}

const REND = /^\d{3,4}p$/;
const SEG = /^seg_\d{5}\.m4s$/;
const THUMB = /^t\d{2}\.jpg$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** Maps the part of the URL after the token to an object of this asset; null when it is not servable. */
export function resolvePlaybackPath(ref: AssetRef, rel: string): Served | null {
  if (rel.length === 0 || rel.length > 200 || rel.includes('\\') || rel.includes('\0')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const base = `${ref.tenantId}/${ref.assetId}`;
  const playlist = 'application/vnd.apple.mpegurl';
  const short = 'private, max-age=60';
  const forever = 'private, max-age=86400';
  const [a, b] = parts;
  if (parts.length === 1) {
    if (a === 'master.m3u8')
      return { key: `${base}/hls/master.m3u8`, contentType: playlist, cacheControl: short };
    if (a === 'poster.jpg')
      return { key: `${base}/poster.jpg`, contentType: 'image/jpeg', cacheControl: forever };
    return null;
  }
  if (parts.length === 2 && a && b) {
    if (REND.test(a) && b === 'index.m3u8')
      return { key: `${base}/hls/${a}/index.m3u8`, contentType: playlist, cacheControl: short };
    if (REND.test(a) && b === 'init.mp4')
      return { key: `${base}/hls/${a}/init.mp4`, contentType: 'video/mp4', cacheControl: forever };
    if (REND.test(a) && SEG.test(b))
      return { key: `${base}/hls/${a}/${b}`, contentType: 'video/mp4', cacheControl: forever };
    if (a === 'thumbs' && THUMB.test(b))
      return { key: `${base}/thumbs/${b}`, contentType: 'image/jpeg', cacheControl: forever };
    if (a === 'captions' && b.endsWith('.vtt') && LANG.test(b.slice(0, -4)))
      return {
        key: `${base}/captions/${b}`,
        contentType: 'text/vtt; charset=utf-8',
        cacheControl: short,
      };
  }
  return null;
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/** Parses a single-range `Range: bytes=...` header (the only form players use). */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: 'none' }; // multi-range / other units: answer the whole object
  const [, from, to] = m;
  if (from === '' && to === '') return { kind: 'unsatisfiable' };
  let start: number;
  let end: number;
  if (from === '') {
    const n = Number(to);
    if (n === 0) return { kind: 'unsatisfiable' };
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}
