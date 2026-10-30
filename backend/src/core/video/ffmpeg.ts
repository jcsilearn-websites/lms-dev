import { spawn } from 'node:child_process';
import path from 'node:path';

// ffmpeg / ffprobe for the LOCAL video provider (development and CI only: ffmpeg is never shipped in a production
// image, see ADR 0015). The input is untrusted, so: no shell, an explicit argument array, `-protocol_whitelist file`
// (no network, no concat/subfile tricks), `-nostdin`, a hard timeout, output only below the job's own directory,
// and the process is killed when the job is aborted.

export const SEGMENT_SECONDS = 6;

// ---------------------------------------------------------------- rejection reasons
export type RejectCode =
  | 'unsupported_format'
  | 'corrupt'
  | 'no_video'
  | 'too_long'
  | 'bad_dimensions'
  | 'unexpected_streams';

/** The input is not acceptable; `message` is written for the person who uploaded it. */
export class VideoRejectedError extends Error {
  constructor(
    readonly code: RejectCode,
    message: string,
  ) {
    super(message);
    this.name = 'VideoRejectedError';
  }
}

/** ffmpeg / ffprobe could not run (missing binary, crash, timeout): not the input's fault, so the job retries. */
export class FfmpegFailedError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegFailedError';
  }
}

export class FfmpegAbortedError extends Error {
  constructor() {
    super('ffmpeg was stopped');
    this.name = 'FfmpegAbortedError';
  }
}

// ---------------------------------------------------------------- running a process
export interface RunOptions {
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  /** Receives every line written to stdout (the `-progress pipe:1` stream). */
  onStdoutLine?: ((line: string) => void) | undefined;
  cwd?: string | undefined;
}

/** Runs a binary without a shell; resolves with its stdout, rejects on non-zero exit, timeout or abort. */
export function run(bin: string, args: readonly string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new FfmpegAbortedError());
    const child = spawn(bin, [...args], {
      shell: false,
      windowsHide: true,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let tail = '';
    let pending = '';
    let settled = false;
    /** why we stopped it (timeout / abort): reported once the process has really exited */
    let stoppedBecause: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    // Stop the process and wait until it has really exited before reporting: the caller removes its working
    // directory next, and a process that is still dying holds files open (EBUSY on Windows).
    const stop = (why: Error) => {
      if (stoppedBecause) return;
      stoppedBecause = why;
      if (!child.killed) child.kill('SIGKILL');
      killTimer = setTimeout(() => finish(() => reject(why)), 5000);
    };
    const timer = setTimeout(
      () => stop(new FfmpegFailedError('ffmpeg timed out', tail)),
      opts.timeoutMs,
    );
    const onAbort = () => stop(new FfmpegAbortedError());
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      if (opts.onStdoutLine) {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const l of lines) opts.onStdoutLine(l.trim());
      } else if (stdout.length < 4_000_000) {
        stdout += text;
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-8192);
    });
    child.on('error', (err) =>
      finish(() =>
        reject(
          new FfmpegFailedError(`could not start ${path.basename(bin)}: ${err.message}`, tail),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        if (stoppedBecause) reject(stoppedBecause);
        else if (code === 0) resolve(stdout);
        else reject(new FfmpegFailedError(`${path.basename(bin)} exited with code ${code}`, tail));
      }),
    );
  });
}

// ---------------------------------------------------------------- probing
export const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm'] as const;
export type Container = 'mp4' | 'mov' | 'mkv' | 'webm';

export interface Probe {
  container: Container;
  formatName: string;
  durationSeconds: number;
  /** display size (rotation applied) */
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  bitRate: number | null;
}

export interface ProbeLimits {
  maxDurationSeconds: number;
  maxSide: number;
  minSide: number;
  maxFps: number;
}

export const DEFAULT_PROBE_LIMITS = { maxSide: 4096, minSide: 64, maxFps: 120 };

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
interface RawProbe {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: RawStream[];
}

const parseRate = (r: string | undefined): number => {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d || !Number.isFinite(n) || !Number.isFinite(d)) return 0;
  return n / d;
};

export function extensionOf(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

/** Judges ffprobe's JSON. Pure, so every rejection is unit tested without a media file. */
export function judgeProbe(raw: RawProbe, fileName: string, limits: ProbeLimits): Probe {
  const ext = extensionOf(fileName);
  const formatName = raw.format?.format_name ?? '';
  const isMov = formatName.split(',').includes('mov');
  const isMatroska = formatName.split(',').includes('matroska');
  if (!isMov && !isMatroska) {
    throw new VideoRejectedError(
      'unsupported_format',
      'This is not a video file we can use. Upload an MP4, MOV, MKV or WebM file.',
    );
  }
  // the extension must agree with what the content turned out to be
  const extOk = isMov ? ext === '.mp4' || ext === '.mov' : ext === '.mkv' || ext === '.webm';
  if (!extOk) {
    throw new VideoRejectedError(
      'unsupported_format',
      'The file extension does not match the content of the file.',
    );
  }
  const streams = raw.streams ?? [];
  if (streams.length > 16) {
    throw new VideoRejectedError('unexpected_streams', 'The file contains too many streams.');
  }
  const videos = streams.filter(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  const audios = streams.filter((s) => s.codec_type === 'audio');
  if (videos.length === 0) {
    throw new VideoRejectedError('no_video', 'The file has no video track.');
  }
  if (videos.length > 1) {
    throw new VideoRejectedError(
      'unexpected_streams',
      'The file has more than one video track. Export it with a single video track.',
    );
  }
  if (audios.length > 8) {
    throw new VideoRejectedError('unexpected_streams', 'The file has too many audio tracks.');
  }
  const v = videos[0] as RawStream;
  const duration = Number(raw.format?.duration ?? v.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoRejectedError('corrupt', 'The file looks damaged: its length cannot be read.');
  }
  if (duration > limits.maxDurationSeconds) {
    const hours = Math.round((limits.maxDurationSeconds / 3600) * 10) / 10;
    throw new VideoRejectedError(
      'too_long',
      `The video is longer than the limit of ${hours} hours.`,
    );
  }
  let width = Number(v.width);
  let height = Number(v.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new VideoRejectedError(
      'corrupt',
      'The file looks damaged: the picture size cannot be read.',
    );
  }
  const rotation = Math.abs(
    Number(
      v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0,
    ),
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  if (Math.min(width, height) < limits.minSide || Math.max(width, height) > limits.maxSide) {
    throw new VideoRejectedError(
      'bad_dimensions',
      `The picture size (${width}x${height}) is outside what we accept (from ${limits.minSide} up to ${limits.maxSide} pixels).`,
    );
  }
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30;
  if (fps > limits.maxFps) {
    throw new VideoRejectedError(
      'bad_dimensions',
      `The frame rate (${Math.round(fps)} fps) is too high.`,
    );
  }
  const container: Container = isMov
    ? ext === '.mov'
      ? 'mov'
      : 'mp4'
    : ext === '.webm'
      ? 'webm'
      : 'mkv';
  const bitRate = Number(raw.format?.bit_rate);
  return {
    container,
    formatName,
    durationSeconds: duration,
    width,
    height,
    fps,
    videoCodec: v.codec_name ?? 'unknown',
    audioCodec: audios[0]?.codec_name ?? null,
    hasAudio: audios.length > 0,
    bitRate: Number.isFinite(bitRate) ? bitRate : null,
  };
}

/** ffprobe a file; throws VideoRejectedError for anything that is not an acceptable video. */
export async function probeFile(
  ffprobePath: string,
  file: string,
  fileName: string,
  limits: ProbeLimits,
  signal?: AbortSignal,
): Promise<Probe> {
  let out: string;
  try {
    out = await run(
      ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-probesize',
        '20M',
        '-analyzeduration',
        '10M',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        file,
      ],
      { timeoutMs: 60_000, signal },
    );
  } catch (err) {
    if (err instanceof FfmpegFailedError) {
      if (/moov atom|End of file|Truncated/i.test(err.stderr)) {
        throw new VideoRejectedError('corrupt', 'The file looks damaged or incomplete.');
      }
      if (/Invalid data found|EBML|Invalid argument/i.test(err.stderr)) {
        throw new VideoRejectedError(
          'unsupported_format',
          'This is not a video file we can use. Upload an MP4, MOV, MKV or WebM file.',
        );
      }
    }
    throw err;
  }
  let raw: RawProbe;
  try {
    raw = JSON.parse(out) as RawProbe;
  } catch {
    throw new FfmpegFailedError('ffprobe printed something that is not JSON', out.slice(0, 200));
  }
  return judgeProbe(raw, fileName, limits);
}

// ---------------------------------------------------------------- the ladder
export interface Rendition {
  name: string;
  /** the short side of the picture, in pixels */
  shortSide: number;
  width: number;
  height: number;
  /** video maxrate, kbit/s (crf-capped) */
  videoKbps: number;
  audioKbps: number;
}

const LADDER = [
  { name: '360p', shortSide: 360, videoKbps: 400, audioKbps: 64 },
  { name: '480p', shortSide: 480, videoKbps: 700, audioKbps: 96 },
  { name: '720p', shortSide: 720, videoKbps: 1300, audioKbps: 96 },
] as const;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The renditions for a source: every ladder step that does not exceed the source's short side (never upscale),
 * capped at 720. A source smaller than 360 gets one rendition at its own size. The step is named for the SHORT
 * side so a portrait video is capped like a landscape one (1080x1920 -> 720x1280, not 1280x2276).
 */
export function planRenditions(width: number, height: number): Rendition[] {
  const short = Math.min(width, height);
  const dims = (target: number) => {
    const scale = target / short;
    return { width: even(width * scale), height: even(height * scale) };
  };
  const steps = LADDER.filter((l) => l.shortSide <= short);
  if (steps.length === 0) {
    const bitrate = Math.round(Math.min(400, Math.max(150, (400 * width * height) / (640 * 360))));
    return [
      {
        name: `${even(short)}p`,
        shortSide: even(short),
        width: even(width),
        height: even(height),
        videoKbps: bitrate,
        audioKbps: 64,
      },
    ];
  }
  return steps.map((l) => ({ ...l, ...dims(l.shortSide) }));
}

/** Output frame rate: the source's, rounded, never above 30 (lectures do not need more). */
export function outputFps(sourceFps: number): number {
  return Math.min(30, Math.max(1, Math.round(sourceFps)));
}

// ---------------------------------------------------------------- command lines
export interface TranscodePlan {
  input: string;
  /** directory the HLS tree is written to (must be below `workDir`) */
  outDir: string;
  workDir: string;
  probe: Probe;
  renditions: Rendition[];
  threads: number;
}

/** Throws unless `target` is inside `dir`: output may only go into the job's own directory. */
export function assertInside(dir: string, target: string): void {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('output path is outside the job directory');
  }
}

/**
 * The HLS muxer finds the directory of its playlist by looking for `/`: with Windows separators it would put the
 * init segment into the working directory instead of next to the playlist. ffmpeg accepts `/` on every platform.
 */
const ffPath = (p: string): string => p.split(path.sep).join('/');

/**
 * ONE ffmpeg run decodes the source once and writes every rendition as its own HLS output: H.264 (capped CRF,
 * veryfast) + AAC in fragmented-MP4 segments of 6 s, with an init segment next to each rendition's playlist
 * (`<out>/<name>/index.m3u8`, `init.mp4`, `seg_00000.m4s`...). Key frames are forced at the same instants in
 * every rendition (`expr:gte(t,n_forced*6)`, scenecut off, constant frame rate, GOP = 6 s of frames) so a player
 * can switch quality at any segment boundary without a glitch. The master playlist is written afterwards
 * (`masterPlaylist`) from what was really produced.
 */
export function transcodeArgs(p: TranscodePlan): string[] {
  assertInside(p.workDir, p.outDir);
  const fps = outputFps(p.probe.fps);
  const gop = fps * SEGMENT_SECONDS;
  const n = p.renditions.length;
  const split = p.renditions.map((_, i) => `[s${i}]`).join('');
  const scales = p.renditions
    .map((r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic,setsar=1[v${i}]`)
    .join(';');
  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-y',
    '-protocol_whitelist',
    'file',
    '-i',
    p.input,
    '-filter_complex',
    `[0:v:0]fps=${fps},split=${n}${split};${scales}`,
  ];
  p.renditions.forEach((r, i) => {
    const dir = path.join(p.outDir, r.name);
    assertInside(p.workDir, dir);
    args.push('-map', `[v${i}]`);
    if (p.probe.hasAudio) args.push('-map', '0:a:0');
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      h264Profile(r),
      '-maxrate',
      `${r.videoKbps}k`,
      '-bufsize',
      `${r.videoKbps * 2}k`,
      '-sc_threshold',
      '0',
      '-g',
      String(gop),
      '-keyint_min',
      String(gop),
      '-force_key_frames',
      `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    );
    if (p.probe.hasAudio)
      args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', `${r.audioKbps}k`);
    if (p.threads > 0) args.push('-threads', String(p.threads));
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_SECONDS),
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_segment_filename',
      ffPath(path.join(dir, 'seg_%05d.m4s')),
      ffPath(path.join(dir, 'index.m3u8')),
    );
  });
  return args;
}

export const h264Profile = (r: Pick<Rendition, 'shortSide'>): 'main' | 'high' =>
  r.shortSide >= 720 ? 'high' : 'main';

/** The lowest H.264 level that fits the picture size and frame rate (level_idc: 30 = 3.0, 31 = 3.1 ...). */
export function h264Level(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  // level_idc, MaxFS (macroblocks per frame), MaxMBPS (macroblocks per second)
  const levels: [number, number, number][] = [
    [30, 1620, 40500],
    [31, 3600, 108000],
    [32, 5120, 216000],
    [40, 8192, 245760],
    [41, 8192, 245760],
    [42, 8704, 522240],
    [50, 22080, 589824],
    [51, 36864, 983040],
  ];
  return levels.find(([, fs, mbps]) => mbs <= fs && rate <= mbps)?.[0] ?? 51;
}

/** RFC 6381 codec string of a rendition: avc1.<profile><constraints><level> (+ mp4a.40.2 for AAC-LC). */
export function codecString(r: Rendition, fps: number, hasAudio: boolean): string {
  const profile = h264Profile(r) === 'high' ? '6400' : '4d40';
  const level = h264Level(r.width, r.height, fps).toString(16).padStart(2, '0');
  return `avc1.${profile}${level}${hasAudio ? ',mp4a.40.2' : ''}`;
}

export interface Segment {
  name: string;
  seconds: number;
}

/** The segments (file name + duration) of a media playlist. */
export function parseSegments(playlist: string): Segment[] {
  const out: Segment[] = [];
  let seconds: number | null = null;
  for (const line of playlist.split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m?.[1]) seconds = Number(m[1]);
    else if (line && !line.startsWith('#') && seconds !== null) {
      out.push({ name: line.trim(), seconds });
      seconds = null;
    }
  }
  return out;
}

export interface MasterEntry {
  rendition: Rendition;
  codecs: string;
  fps: number;
  /** highest bit rate of any segment, bit/s */
  peakBps: number;
  /** total bytes / total seconds, bit/s */
  averageBps: number;
}

/** The master playlist: one variant per rendition, lowest first (players start low and climb). */
export function masterPlaylist(entries: readonly MasterEntry[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const e of entries) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(e.peakBps)},AVERAGE-BANDWIDTH=${Math.round(e.averageBps)},` +
        `RESOLUTION=${e.rendition.width}x${e.rendition.height},FRAME-RATE=${e.fps.toFixed(3)},CODECS="${e.codecs}"`,
      `${e.rendition.name}/index.m3u8`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One frame as the poster (a little way in, never past the end). */
export function posterArgs(
  input: string,
  out: string,
  workDir: string,
  durationSeconds: number,
): string[] {
  assertInside(workDir, out);
  const at = Math.min(10, durationSeconds * 0.1);
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    '-ss',
    at.toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-q:v',
    '4',
    out,
  ];
}

/** `count` evenly spaced 320-pixel thumbnails (`<dir>/t01.jpg`, ...). */
export function thumbnailArgs(
  input: string,
  dir: string,
  workDir: string,
  durationSeconds: number,
  count: number,
): string[] {
  assertInside(workDir, dir);
  const rate = Math.max(count / durationSeconds, 0.0001);
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    '-i',
    input,
    '-vf',
    `fps=${rate.toFixed(6)},scale=320:-2`,
    '-frames:v',
    String(count),
    '-q:v',
    '5',
    path.join(dir, 't%02d.jpg'),
  ];
}

/** The `out_time_us=` value of an ffmpeg `-progress` stream in seconds, or null for any other line. */
export function progressSeconds(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
  return m?.[1] ? Number(m[1]) / 1_000_000 : null;
}
