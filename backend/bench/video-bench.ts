import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROBE_LIMITS,
  parseSegments,
  planRenditions,
  probeFile,
  run,
  transcodeArgs,
} from '../src/core/video';

// Step 7 benchmarks and the numbers behind docs/video-cost-model.md:
//   1. transcode time per minute of source on THIS machine (the local provider, ffmpeg veryfast, 3 renditions);
//   2. the real size of every rendition per hour of viewing, for a lecture-like and a high-motion sample, with
//      fragmented-MP4 segments (what the product produces) and, once, MPEG-TS segments for comparison;
//   3. the latency of the playback-session endpoint (HTTP, against the TEST database, see playbackLatency).
//
//   pnpm --filter @lms/backend run bench:video          VIDEO_BENCH_SECONDS=300 (length of each sample)
//
// The samples are generated with ffmpeg (a test pattern, drawn boxes, noise and tones): no copyrighted material.

const SECONDS = Number(process.env.VIDEO_BENCH_SECONDS ?? 300);
const DIR = path.resolve(process.env.VIDEO_BENCH_DIR ?? '.video-bench');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

interface Sample {
  name: string;
  /** what it stands for */
  about: string;
  video: string[];
  audio: string[];
}

const SAMPLES: Sample[] = [
  {
    name: 'lecture-like',
    about:
      'slides: a white page with a title bar and lines of "text" that change every 20 s, a small moving region (an instructor window or pointer)',
    video: [
      '-f',
      'lavfi',
      '-i',
      [
        `color=c=white:s=1280x720:r=25:d=${SECONDS}`,
        'drawbox=x=0:y=0:w=1280:h=90:color=0x1f3a68:t=fill',
        ...[150, 200, 250, 300, 350, 400, 450].map(
          (y, i) =>
            `drawbox=x=100:y=${y}:w=${600 + ((i * 97) % 450)}:h=14:color=black:t=fill:enable='lt(mod(t,40),20)'`,
        ),
        ...[170, 230, 290, 350, 410, 470].map(
          (y, i) =>
            `drawbox=x=140:y=${y}:w=${500 + ((i * 131) % 500)}:h=14:color=0x333333:t=fill:enable='gte(mod(t,40),20)'`,
        ),
        "drawbox=x='mod(t*50,1100)':y=560:w=140:h=100:color=orange:t=fill",
      ].join(','),
    ],
    audio: ['-f', 'lavfi', '-i', `anoisesrc=d=${SECONDS}:c=pink:a=0.05`],
  },
  {
    name: 'high-motion',
    about:
      'a moving test pattern with constant noise and a colour shift: close to the worst case for the encoder',
    video: [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=1280x720:r=25:d=${SECONDS},noise=alls=12:allf=t+u,hue=H='2*PI*t/10'`,
    ],
    audio: ['-f', 'lavfi', '-i', `anoisesrc=d=${SECONDS}:c=pink:a=0.05`],
  },
];

const dirSize = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) =>
      n +
      (e.isDirectory() ? dirSize(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).size),
    0,
  );

/** The same ladder with MPEG-TS segments instead of fragmented MP4 (for the comparison only). */
function toMpegTs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-hls_fmp4_init_filename') {
      i++; // the value
      continue;
    }
    if (a === '-hls_segment_type') {
      out.push(a, 'mpegts');
      i++;
      continue;
    }
    out.push(a.replace(/seg_%05d\.m4s$/, 'seg_%05d.ts'));
  }
  return out;
}

interface Result {
  sample: string;
  container: 'fMP4' | 'TS';
  seconds: number;
  transcodeSeconds: number;
  speedX: number;
  perRendition: {
    name: string;
    width: number;
    height: number;
    videoKbps: number;
    bytes: number;
    gbPerHour: number;
    kbps: number;
  }[];
}

async function transcode(
  sample: Sample,
  source: string,
  container: 'fMP4' | 'TS',
): Promise<Result> {
  const probe = await probeFile(FFPROBE, source, 'sample.mp4', {
    ...DEFAULT_PROBE_LIMITS,
    maxDurationSeconds: 10 * 3600,
  });
  const renditions = planRenditions(probe.width, probe.height);
  const work = path.join(DIR, `${sample.name}-${container}`);
  rmSync(work, { recursive: true, force: true });
  const outDir = path.join(work, 'hls');
  for (const r of renditions) mkdirSync(path.join(outDir, r.name), { recursive: true });
  let args = transcodeArgs({ input: source, outDir, workDir: work, probe, renditions, threads: 0 });
  if (container === 'TS') args = toMpegTs(args);
  const t0 = performance.now();
  await run(FFMPEG, args, { timeoutMs: 6 * 3600_000, cwd: work });
  const transcodeSeconds = (performance.now() - t0) / 1000;
  return {
    sample: sample.name,
    container,
    seconds: probe.durationSeconds,
    transcodeSeconds,
    speedX: probe.durationSeconds / transcodeSeconds,
    perRendition: renditions.map((r) => {
      const dir = path.join(outDir, r.name);
      const bytes = dirSize(dir); // init segment + media segments + the playlist: everything a viewer downloads
      const segs = parseSegments(readFileSync(path.join(dir, 'index.m3u8'), 'utf8'));
      const length = segs.reduce((n, s) => n + s.seconds, 0) || probe.durationSeconds;
      return {
        name: r.name,
        width: r.width,
        height: r.height,
        videoKbps: r.videoKbps,
        bytes,
        gbPerHour: ((bytes / length) * 3600) / 1e9,
        kbps: (bytes * 8) / length / 1000,
      };
    }),
  };
}

async function playbackLatency(): Promise<
  { runs: number; p50: number; p99: number; reqPerSec: number } | string
> {
  // Needs the TEST database (VITEST_POOL_ID=1 selects lms_test_1) and the helpers of the test suite.
  try {
    const { default: autocannon } = await import('autocannon');
    const { makeApp } = await import('../test/app');
    const { createAuthFixture, testOwnerPool } = await import('../test/support');
    const h = await import('../test/courses-helpers');
    const { newId } = await import('../src/core/uuid');
    const owner = testOwnerPool();
    const t = makeApp({ env: { RATE_LIMIT_MAX: '1000000' } });
    try {
      const A = await createAuthFixture(
        owner,
        `vb-bench-${Math.random().toString(36).slice(2, 7)}`,
      );
      await t.app.ready();
      const admin = await h.loginAs(t, A.host, A.adminEmail);
      const s = await h.structure(admin);
      const o = await h.newOffering(admin, (await h.newCourse(admin)).id, s.termId);
      const learner = await h.person(owner, t, A, 'Learner');
      const teacher = await h.person(owner, t, A, 'Teacher');
      h.ok(
        await admin.post(`/offerings/${o.id}/participants`, {
          userId: learner.userId,
          participation: 'learner',
        }),
      );
      h.ok(
        await admin.post(`/offerings/${o.id}/participants`, {
          userId: teacher.userId,
          participation: 'instructor',
        }),
      );
      h.ok(await teacher.client.post(`/offerings/${o.id}/publish`));
      const m = h.ok(await teacher.client.post(`/offerings/${o.id}/modules`, { title: 'M' }));
      h.ok(await teacher.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
      const video = newId();
      await owner.query(
        `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status,
                                       duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
         VALUES ($1, $2, $3, $4, 'b.mp4', 1000, 'ready', 4000, 'x', now(), 1000, 100, '[]'::jsonb)`,
        [video, A.tenantId, o.id, teacher.userId],
      );
      const item = h.ok(
        await teacher.client.post(`/offerings/${o.id}/modules/${m.id}/items`, {
          kind: 'video',
          title: 'L',
          videoId: video,
          published: true,
        }),
      );
      await t.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (t.app.server.address() as { port: number }).port;
      const cookie = [...learner.client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const result = await autocannon({
        url: `http://127.0.0.1:${port}/api/offerings/${o.id}/items/${item.id}/playback`,
        method: 'POST',
        connections: 10,
        duration: 8,
        headers: { host: A.host, origin: `http://${A.host}`, 'x-requested-with': 'lms', cookie },
      });
      return {
        runs: result.requests.total,
        p50: result.latency.p50,
        p99: result.latency.p99,
        reqPerSec: Math.round(result.requests.average),
      };
    } finally {
      await t.close();
      await owner.end();
    }
  } catch (err) {
    return `skipped (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
  }
}

async function main(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const version = execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' }).split('\n')[0];
  const cpus = os.cpus();
  console.log(
    `# Video benchmark\n\n- ${version}\n- ${cpus.length} x ${cpus[0]?.model.trim()} (${Math.round(os.totalmem() / 1e9)} GB RAM), ${process.platform}\n- samples: ${SECONDS} s each, 1280x720, 25 fps\n`,
  );

  const results: Result[] = [];
  // VIDEO_BENCH_ONLY=latency skips the (minutes long) transcodes
  for (const sample of process.env.VIDEO_BENCH_ONLY === 'latency' ? [] : SAMPLES) {
    const source = path.join(DIR, `${sample.name}.mp4`);
    execFileSync(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...sample.video,
        ...sample.audio,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        source,
      ],
      { stdio: 'inherit' },
    );
    console.log(
      `source ${sample.name}: ${(statSync(source).size / 1e6).toFixed(1)} MB, ${sample.about}`,
    );
    results.push(await transcode(sample, source, 'fMP4'));
    // MPEG-TS for comparison: once, on the lecture-like sample
    if (sample.name === 'lecture-like') results.push(await transcode(sample, source, 'TS'));
  }

  console.log(
    '\n## Transcode time (this machine, ffmpeg -preset veryfast, 3 renditions in one run)\n',
  );
  console.log(
    '| sample | segments | source length | transcode time | minutes of work per minute of video | speed |',
  );
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    console.log(
      `| ${r.sample} | ${r.container} | ${r.seconds.toFixed(0)} s | ${r.transcodeSeconds.toFixed(1)} s | ${(r.transcodeSeconds / (r.seconds / 60)).toFixed(2)} min | ${r.speedX.toFixed(2)}x real time |`,
    );
  }
  console.log('\n## Size per hour of viewing\n');
  console.log(
    '| sample | segments | rendition | picture | video cap | average bit rate | GB per viewing hour (decimal) | MB per viewing hour |',
  );
  console.log('| --- | --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    for (const x of r.perRendition) {
      console.log(
        `| ${r.sample} | ${r.container} | ${x.name} | ${x.width}x${x.height} | ${x.videoKbps} kbps | ${x.kbps.toFixed(0)} kbps | ${x.gbPerHour.toFixed(3)} | ${(x.gbPerHour * 1000).toFixed(0)} |`,
      );
    }
  }
  const lecture = (c: string) =>
    results.find((r) => r.sample === 'lecture-like' && r.container === c);
  const fm = lecture('fMP4');
  const ts = lecture('TS');
  if (fm && ts) {
    console.log('\n## fMP4 against MPEG-TS (lecture-like sample, same encoder settings)\n');
    console.log('| rendition | fMP4 GB/h | TS GB/h | TS overhead |');
    console.log('| --- | ---: | ---: | ---: |');
    for (const x of fm.perRendition) {
      const y = ts.perRendition.find((z) => z.name === x.name);
      if (y)
        console.log(
          `| ${x.name} | ${x.gbPerHour.toFixed(3)} | ${y.gbPerHour.toFixed(3)} | ${(((y.bytes - x.bytes) / x.bytes) * 100).toFixed(1)} % |`,
        );
    }
  }

  console.log(
    '\n## Playback-session endpoint (POST /api/offerings/:id/items/:itemId/playback, 10 connections, 8 s)\n',
  );
  const lat = await playbackLatency();
  console.log(
    typeof lat === 'string'
      ? lat
      : `${lat.reqPerSec} requests/s, p50 ${lat.p50} ms, p99 ${lat.p99} ms (${lat.runs} requests)`,
  );

  writeFileSync(
    path.join(DIR, 'results.json'),
    JSON.stringify(
      { version, cpus: cpus.length, seconds: SECONDS, results, latency: lat },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
