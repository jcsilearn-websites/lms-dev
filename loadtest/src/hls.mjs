// The little of HLS a simulated viewer needs: which playlists to fetch, which segments to pull and how long each one plays.

/** The variant playlists of a master playlist, in order: `[{ name, uri, bandwidth, height }]` (uri relative to the master). */
export function parseMaster(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const uri = (lines[i + 1] ?? '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const attrs = m[1] ?? '';
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(attrs)?.[1] ?? 0);
    const height = Number(/RESOLUTION=\d+x(\d+)/.exec(attrs)?.[1] ?? 0);
    out.push({ uri, bandwidth, height, name: height ? `${height}p` : uri });
  }
  return out;
}

/** A media playlist: the init segment (fMP4, `#EXT-X-MAP`) and the segments with their durations in seconds. */
export function parseMedia(text) {
  const lines = text.split(/\r?\n/);
  const init = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(text)?.[1] ?? null;
  const segments = [];
  let duration = null;
  for (const line of lines) {
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf) {
      duration = Number(inf[1]);
      continue;
    }
    if (duration !== null && line.trim() && !line.startsWith('#')) {
      segments.push({ uri: line.trim(), seconds: duration });
      duration = null;
    }
  }
  return { init, segments, totalSeconds: segments.reduce((n, s) => n + s.seconds, 0) };
}

/** Picks an index by weights (`[0.2, 0.3, 0.5]`) with a random number in [0, 1). */
export function pickWeighted(weights, r) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}
