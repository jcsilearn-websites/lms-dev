import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertInside,
  codecString,
  createPlaybackTokens,
  createTtlCache,
  DEFAULT_PROBE_LIMITS,
  h264Level,
  judgeProbe,
  masterPlaylist,
  outputFps,
  parseRange,
  parseSegments,
  planRenditions,
  playbackKey,
  posterArgs,
  progressSeconds,
  redactPlaybackUrl,
  resolvePlaybackPath,
  thumbnailArgs,
  tokenOfPlaybackUrl,
  transcodeArgs,
  VideoRejectedError,
} from '../video';

const T = '01a18ce9-0000-7000-8000-000000000001';
const A = '01a18ce9-0000-7000-8000-000000000002';
const U = '01a18ce9-0000-7000-8000-000000000003';

describe('playback tokens', () => {
  const now = 1_800_000_000_000;
  const tokens = createPlaybackTokens('s'.repeat(40), () => now);
  const claims = { t: T, a: A, u: U, e: now / 1000 + 60 };

  it('verifies what it signed, and nothing else', () => {
    const token = tokens.sign(claims);
    expect(tokens.verify(token)).toEqual(claims);
    expect(createPlaybackTokens('x'.repeat(40), () => now).verify(token)).toBeNull(); // another key
    const [payload, mac] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, a: U })).toString('base64url');
    expect(tokens.verify(`${forged}.${mac}`)).toBeNull();
    const last = mac.at(-1) === 'A' ? 'B' : 'A';
    expect(tokens.verify(`${payload}.${mac.slice(0, -1)}${last}`)).toBeNull();
    expect(tokens.verify(`${payload}.${mac}.x`)).toBeNull();
    expect(tokens.verify(payload)).toBeNull();
    expect(tokens.verify('')).toBeNull();
    expect(tokens.verify('x'.repeat(2000))).toBeNull();
  });

  it('expires', () => {
    const token = tokens.sign(claims);
    expect(createPlaybackTokens('s'.repeat(40), () => now + 59_000).verify(token)).not.toBeNull();
    expect(createPlaybackTokens('s'.repeat(40), () => now + 60_000).verify(token)).toBeNull();
    expect(tokens.verify(tokens.sign({ ...claims, e: now / 1000 - 1 }))).toBeNull();
  });

  it('refuses ids that are not UUIDs, even with a genuine signature', () => {
    expect(tokens.verify(tokens.sign({ ...claims, a: '../../etc/passwd' }))).toBeNull();
  });

  it('derives its key from the storage key with its own label (a storage token is never a playback token)', () => {
    const k = playbackKey({ storageSecret: 's'.repeat(40) });
    expect(k).not.toBe('s'.repeat(40));
    expect(k).toBe(playbackKey({ storageSecret: 's'.repeat(40) }));
    expect(playbackKey({ videoSecret: 'v'.repeat(40), storageSecret: 's'.repeat(40) })).toBe(
      'v'.repeat(40),
    );
  });

  it('finds and redacts the token of a playback URL', () => {
    expect(tokenOfPlaybackUrl(`/api/video/play/abc.def/${A}/master.m3u8`)).toBe('abc.def');
    expect(tokenOfPlaybackUrl('/api/members')).toBeNull();
    expect(redactPlaybackUrl(`/api/video/play/abc.def/${A}/master.m3u8`)).toBe(
      `/api/video/play/[redacted]/${A}/master.m3u8`,
    );
    expect(redactPlaybackUrl('/api/members')).toBe('/api/members');
  });
});

describe('the TTL cache', () => {
  it('forgets after the TTL and never grows past its bound', () => {
    let now = 0;
    const c = createTtlCache<number>({ ttlMs: 1000, max: 3, now: () => now });
    c.set('a', 1);
    now = 999;
    expect(c.get('a')).toBe(1);
    now = 1000;
    expect(c.get('a')).toBeUndefined();
    for (const [i, k] of ['a', 'b', 'c', 'd', 'e'].entries()) c.set(k, i);
    expect(c.size).toBe(3);
    expect(c.get('a')).toBeUndefined(); // the oldest went first
    expect(c.get('e')).toBe(4);
  });
  it('a TTL of 0 caches nothing', () => {
    const c = createTtlCache<number>({ ttlMs: 0, max: 3 });
    c.set('a', 1);
    expect(c.get('a')).toBeUndefined();
  });
});

describe('what a playback token may fetch', () => {
  const ref = { tenantId: T, assetId: A };
  const ok = (rel: string) => resolvePlaybackPath(ref, rel);
  it('maps the allow-listed files to objects of THIS asset', () => {
    expect(ok('master.m3u8')).toMatchObject({
      key: `${T}/${A}/hls/master.m3u8`,
      contentType: 'application/vnd.apple.mpegurl',
    });
    expect(ok('720p/index.m3u8')?.key).toBe(`${T}/${A}/hls/720p/index.m3u8`);
    expect(ok('720p/init.mp4')).toMatchObject({ contentType: 'video/mp4' });
    expect(ok('720p/seg_00012.m4s')?.key).toBe(`${T}/${A}/hls/720p/seg_00012.m4s`);
    expect(ok('poster.jpg')?.contentType).toBe('image/jpeg');
    expect(ok('thumbs/t03.jpg')?.key).toBe(`${T}/${A}/thumbs/t03.jpg`);
    expect(ok('captions/en.vtt')?.contentType).toBe('text/vtt; charset=utf-8');
    expect(ok('captions/pt-BR.vtt')).not.toBeNull();
  });
  it('refuses everything else: the original, traversal, odd names', () => {
    for (const rel of [
      '',
      'source',
      'hls/master.m3u8',
      '../source',
      '720p/../source',
      '720p//index.m3u8',
      '720p/seg_1.m4s',
      '720p/seg_00001.mp4',
      'x720p/index.m3u8',
      'captions/en.txt',
      'captions/EN.vtt',
      'captions/../x.vtt',
      'thumbs/t1.jpg',
      'a\\b',
      'poster.jpg/x',
      `${'a/'.repeat(100)}x`,
      'master.m3u8\0',
    ]) {
      expect(ok(rel), rel).toBeNull();
    }
  });
});

describe('Range', () => {
  it('parses a single range, an open end and a suffix', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=50-5000', 100)).toEqual({ kind: 'range', start: 50, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });
  it('is unsatisfiable past the end; ignores forms it does not serve', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=9-3', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------------------------------
const limits = { ...DEFAULT_PROBE_LIMITS, maxDurationSeconds: 3 * 3600 };
const stream = (over: Record<string, unknown> = {}) => ({
  codec_type: 'video',
  codec_name: 'h264',
  width: 1280,
  height: 720,
  avg_frame_rate: '30/1',
  ...over,
});
const probe = (
  over: Record<string, unknown> = {},
  name = 'a.mp4',
  streams: unknown[] = [stream(), { codec_type: 'audio', codec_name: 'aac' }],
) =>
  judgeProbe(
    {
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '120.5', ...over },
      streams,
    } as never,
    name,
    limits,
  );

describe('judging an ffprobe result', () => {
  it('accepts a normal lecture', () => {
    expect(probe()).toMatchObject({
      container: 'mp4',
      durationSeconds: 120.5,
      width: 1280,
      height: 720,
      fps: 30,
      hasAudio: true,
      audioCodec: 'aac',
    });
    expect(probe({}, 'a.mov').container).toBe('mov');
    expect(
      judgeProbe(
        { format: { format_name: 'matroska,webm', duration: '5' }, streams: [stream()] } as never,
        'a.webm',
        limits,
      ),
    ).toMatchObject({ container: 'webm', hasAudio: false });
  });
  it('rejects what is not a video, with a reason a person can read', () => {
    const reject = (fn: () => unknown, code: string) => {
      try {
        fn();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(VideoRejectedError);
        expect((e as VideoRejectedError).code).toBe(code);
        expect((e as VideoRejectedError).message.length).toBeGreaterThan(15);
      }
    };
    reject(
      () =>
        judgeProbe({ format: { format_name: 'pdf_pipe' }, streams: [] } as never, 'a.mp4', limits),
      'unsupported_format',
    );
    reject(
      () =>
        judgeProbe(
          {
            format: { format_name: 'wav', duration: '3' },
            streams: [{ codec_type: 'audio' }],
          } as never,
          'a.mp4',
          limits,
        ),
      'unsupported_format',
    );
    reject(() => probe({}, 'a.mkv'), 'unsupported_format'); // an MP4 named .mkv
    reject(() => probe({}, 'a.exe'), 'unsupported_format');
    reject(() => probe({}, 'a.mp4', [{ codec_type: 'audio' }]), 'no_video');
    reject(() => probe({}, 'a.mp4', [stream({ disposition: { attached_pic: 1 } })]), 'no_video'); // cover art only
    reject(() => probe({}, 'a.mp4', [stream(), stream()]), 'unexpected_streams');
    reject(
      () =>
        probe({}, 'a.mp4', [
          stream(),
          ...Array.from({ length: 9 }, () => ({ codec_type: 'audio' })),
        ]),
      'unexpected_streams',
    );
    reject(
      () =>
        probe(
          {},
          'a.mp4',
          Array.from({ length: 17 }, () => ({ codec_type: 'data' })),
        ),
      'unexpected_streams',
    );
    reject(() => probe({ duration: 'N/A' }), 'corrupt');
    reject(() => probe({ duration: '0' }), 'corrupt');
    reject(() => probe({ duration: String(3 * 3600 + 1) }), 'too_long');
    reject(() => probe({}, 'a.mp4', [stream({ width: 0, height: 0 })]), 'corrupt');
    reject(() => probe({}, 'a.mp4', [stream({ width: 32, height: 24 })]), 'bad_dimensions');
    reject(() => probe({}, 'a.mp4', [stream({ width: 7680, height: 4320 })]), 'bad_dimensions');
    reject(() => probe({}, 'a.mp4', [stream({ avg_frame_rate: '240/1' })]), 'bad_dimensions');
  });
  it('applies the rotation of a phone video before judging the size', () => {
    const p = probe({}, 'a.mp4', [
      stream({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }),
    ]);
    expect([p.width, p.height]).toEqual([1080, 1920]);
  });
  it('takes the frame rate from the average, then the real rate, else 30', () => {
    expect(probe({}, 'a.mp4', [stream({ avg_frame_rate: '0/0', r_frame_rate: '25/1' })]).fps).toBe(
      25,
    );
    expect(probe({}, 'a.mp4', [stream({ avg_frame_rate: '0/0' })]).fps).toBe(30);
  });
});

describe('the ladder', () => {
  const dims = (w: number, h: number) =>
    planRenditions(w, h).map((r) => [r.name, r.width, r.height]);
  it('stops at 720 and never upscales', () => {
    expect(dims(1920, 1080)).toEqual([
      ['360p', 640, 360],
      ['480p', 852, 480],
      ['720p', 1280, 720],
    ]);
    expect(dims(3840, 2160).map((r) => r[0])).toEqual(['360p', '480p', '720p']);
    expect(dims(1280, 720).at(-1)).toEqual(['720p', 1280, 720]);
    expect(dims(854, 480).map((r) => r[0])).toEqual(['360p', '480p']);
    expect(dims(640, 360).map((r) => r[0])).toEqual(['360p']);
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [854, 480],
      [640, 360],
      [1080, 1920],
      [400, 300],
    ] as const) {
      for (const r of planRenditions(w, h)) {
        expect(r.width).toBeLessThanOrEqual(w);
        expect(r.height).toBeLessThanOrEqual(h);
        expect(r.width % 2).toBe(0);
        expect(r.height % 2).toBe(0);
      }
    }
  });
  it('a source below the lowest step keeps its own size and a smaller bit rate', () => {
    const [r, ...rest] = planRenditions(320, 240);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ name: '240p', width: 320, height: 240 });
    expect(r?.videoKbps).toBeLessThan(400);
  });
  it('names a portrait video by its short side', () => {
    expect(dims(1080, 1920)).toEqual([
      ['360p', 360, 640],
      ['480p', 480, 852],
      ['720p', 720, 1280],
    ]);
  });
  it('has the lecture bit rates', () => {
    expect(planRenditions(1920, 1080).map((r) => [r.videoKbps, r.audioKbps])).toEqual([
      [400, 64],
      [700, 96],
      [1300, 96],
    ]);
  });
  it('caps the frame rate at 30', () => {
    expect([outputFps(24), outputFps(29.97), outputFps(60), outputFps(0.2)]).toEqual([
      24, 30, 30, 1,
    ]);
  });
});

describe('the ffmpeg command lines', () => {
  const work = path.resolve('work');
  const plan = (hasAudio = true, fps = 25) => {
    const p = probe({}, 'a.mp4', [
      stream({ avg_frame_rate: `${fps}/1` }),
      ...(hasAudio ? [{ codec_type: 'audio', codec_name: 'aac' }] : []),
    ]);
    return {
      input: path.join(work, 'in.mp4'),
      outDir: path.join(work, 'hls'),
      workDir: work,
      probe: p,
      renditions: planRenditions(1280, 720),
      threads: 0,
    };
  };
  it('never lets ffmpeg read anything but a file, and never uses a shell', () => {
    const args = transcodeArgs(plan());
    expect(
      args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2),
    ).toEqual(['-protocol_whitelist', 'file']);
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-nostdin');
    expect(args.filter((a) => /[;&|`$]/.test(a) && !a.startsWith('['))).toEqual([]);
  });
  it('is the same GOP, key frames and segments in every rendition', () => {
    const args = transcodeArgs(plan(true, 25));
    const at = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    expect(at('-g')).toEqual(['150', '150', '150']); // 6 s of 25 fps
    expect(at('-keyint_min')).toEqual(['150', '150', '150']);
    expect(at('-sc_threshold')).toEqual(['0', '0', '0']);
    expect(new Set(at('-force_key_frames'))).toEqual(new Set(['expr:gte(t,n_forced*6)']));
    expect(at('-hls_time')).toEqual(['6', '6', '6']);
    expect(at('-hls_segment_type')).toEqual(['fmp4', 'fmp4', 'fmp4']);
    expect(at('-hls_fmp4_init_filename')).toEqual(['init.mp4', 'init.mp4', 'init.mp4']);
    expect(at('-maxrate')).toEqual(['400k', '700k', '1300k']);
    expect(at('-bufsize')).toEqual(['800k', '1400k', '2600k']);
    expect(at('-crf')).toEqual(['23', '23', '23']);
    expect(at('-preset')).toEqual(['veryfast', 'veryfast', 'veryfast']);
    expect(at('-c:v')).toEqual(['libx264', 'libx264', 'libx264']);
    expect(at('-c:a')).toEqual(['aac', 'aac', 'aac']);
    expect(at('-profile:v')).toEqual(['main', 'main', 'high']);
    expect(args.join(' ')).toContain('fps=25');
  });
  it('writes HLS with forward slashes (the muxer finds the playlist directory by them)', () => {
    const args = transcodeArgs(plan());
    const out = args.filter((a) => a.endsWith('index.m3u8') || a.endsWith('seg_%05d.m4s'));
    expect(out).toHaveLength(6);
    expect(out.every((p) => !p.includes('\\'))).toBe(true);
  });
  it('maps no audio when the source has none, and passes the thread limit', () => {
    const args = transcodeArgs({ ...plan(false), threads: 2 });
    expect(args).not.toContain('0:a:0');
    expect(args).not.toContain('-c:a');
    expect(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 2)).toEqual([
      '-threads',
      '2',
    ]);
  });
  it('writes only below the job directory', () => {
    expect(() => assertInside(work, path.join(work, 'hls'))).not.toThrow();
    for (const bad of [
      work,
      path.join(work, '..', 'x'),
      path.resolve('elsewhere'),
      path.join(work, '..', 'work2'),
    ]) {
      expect(() => assertInside(work, bad), bad).toThrow(/outside/);
    }
    expect(() => transcodeArgs({ ...plan(), outDir: path.resolve('elsewhere') })).toThrow(
      /outside/,
    );
    expect(() => posterArgs('in.mp4', path.resolve('elsewhere', 'p.jpg'), work, 10)).toThrow(
      /outside/,
    );
    expect(() => thumbnailArgs('in.mp4', path.resolve('elsewhere'), work, 10, 5)).toThrow(
      /outside/,
    );
  });
  it('takes the poster a little way in, never past the end', () => {
    const at = (d: number) =>
      posterArgs('in.mp4', path.join(work, 'p.jpg'), work, d)[
        posterArgs('in.mp4', path.join(work, 'p.jpg'), work, d).indexOf('-ss') + 1
      ];
    expect(at(3)).toBe('0.300');
    expect(at(600)).toBe('10.000');
  });
  it('reads the progress of ffmpeg', () => {
    expect(progressSeconds('out_time_us=2500000')).toBe(2.5);
    expect(progressSeconds('out_time_ms=1000000')).toBe(1);
    expect(progressSeconds('progress=continue')).toBeNull();
    expect(progressSeconds('out_time_us=N/A')).toBeNull();
  });
});

describe('the master playlist', () => {
  it('lists the renditions, lowest first, with what players need to choose', () => {
    const renditions = planRenditions(1280, 720);
    const entries = renditions.map((r, i) => ({
      rendition: r,
      codecs: codecString(r, 30, true),
      fps: 30,
      peakBps: 500_000 * (i + 1),
      averageBps: 400_000 * (i + 1),
    }));
    const text = masterPlaylist(entries);
    expect(text.startsWith('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n')).toBe(true);
    expect(text).toContain(
      'BANDWIDTH=500000,AVERAGE-BANDWIDTH=400000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="avc1.4d401e,mp4a.40.2"',
    );
    expect(text).toContain('RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.64001f,mp4a.40.2"');
    expect(text.indexOf('360p/index.m3u8')).toBeLessThan(text.indexOf('720p/index.m3u8'));
    expect(text).not.toContain('\\');
  });
  it('picks H.264 levels that fit the picture', () => {
    expect(h264Level(640, 360, 30)).toBe(30);
    expect(h264Level(852, 480, 30)).toBe(31);
    expect(h264Level(1280, 720, 30)).toBe(31);
    expect(h264Level(1920, 1080, 30)).toBe(40);
    expect(codecString(planRenditions(320, 240)[0] as never, 25, false)).toBe('avc1.4d401e');
  });
  it('reads the segments of a media playlist', () => {
    expect(
      parseSegments(
        '#EXTM3U\n#EXTINF:6.000000,\nseg_00000.m4s\n#EXTINF:2.000000,\nseg_00001.m4s\n#EXT-X-ENDLIST\n',
      ),
    ).toEqual([
      { name: 'seg_00000.m4s', seconds: 6 },
      { name: 'seg_00001.m4s', seconds: 2 },
    ]);
  });
});
