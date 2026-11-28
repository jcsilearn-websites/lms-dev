import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  type Browser,
  type DemoOptions,
  type DemoRuntime,
  openOwner,
  openRuntime,
  readState,
  stateDir,
} from './runtime';

// A lecture through the REAL pipeline: resumable chunked upload, the ffmpeg ladder (360/480/720, never upscaled), HLS served
// with signed playback tokens. Used by `demo:seed` for short placeholder lectures and by `demo:video` for real recordings.

export const LECTURE_FORMATS = ['.mp4', '.mov', '.mkv', '.webm'];

export function assertFfmpeg(env: Record<string, string | undefined>): void {
  for (const bin of [env.FFMPEG_PATH ?? 'ffmpeg', env.FFPROBE_PATH ?? 'ffprobe']) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
    } catch {
      throw new Error(
        `${bin} was not found: install ffmpeg (docs/adr/0015-video.md) and try again`,
      );
    }
  }
}

/** A short silent test-pattern clip that stands in until a real recording is attached. */
export function placeholderClip(env: Record<string, string | undefined>, seconds = 30): string {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `placeholder-lecture-${seconds}s.mp4`);
  if (!existsSync(file)) {
    execFileSync(env.FFMPEG_PATH ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=1280x720:r=25:d=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '50',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
  }
  return file;
}

/** Uploads a file as the signed-in teacher and waits until it is ready to play. Returns the video id. */
export async function uploadLecture(
  runtime: DemoRuntime,
  tenantId: string,
  teacher: Browser,
  offeringId: string,
  file: string,
  progress: (message: string) => void = () => {},
): Promise<string> {
  const size = statSync(file).size;
  const O = `/offerings/${offeringId}/videos`;
  const created = await teacher.post(O, { fileName: basename(file), size });
  const chunk = created.upload.chunkBytes as number;
  const buffer = Buffer.alloc(chunk);
  const fd = openSync(file, 'r');
  try {
    for (let offset = 0; offset < size; ) {
      const read = readSync(fd, buffer, 0, chunk, offset);
      const res = await teacher.send(
        'PATCH',
        `/api${O}/${created.video.id}/upload`,
        buffer.subarray(0, read),
        { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
      );
      if (res.status >= 300) throw new Error(`upload failed: ${res.status} ${res.text}`);
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
  await teacher.post(`${O}/${created.video.id}/complete`);
  progress('uploaded; transcoding (a real lecture takes several minutes) ...');
  // the job runs here; if a running worker took it first, wait for that one to finish
  await runtime.drain(tenantId, ['video']);
  for (;;) {
    const video = await teacher.get(`${O}/${created.video.id}`);
    if (video.status === 'ready') return created.video.id;
    if (video.status === 'failed') {
      throw new Error(`the video was refused: ${video.error?.message ?? 'unknown reason'}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export interface AttachOptions extends DemoOptions {
  file: string;
  /** course code, for example CS201 */
  course: string;
  /** title of the video item; with `module`, a new item is made when no item has this title */
  item: string;
  module?: string | undefined;
}

/** `pnpm demo:video`: attaches a real recording to a video item of the demo college. */
export async function attachLecture(
  opts: AttachOptions,
): Promise<{ url: string; seconds: number }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const file = resolve(env.INIT_CWD ?? process.cwd(), opts.file);
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  if (!LECTURE_FORMATS.includes(extname(file).toLowerCase())) {
    throw new Error(`the file must be one of ${LECTURE_FORMATS.join(', ')}`);
  }
  assertFfmpeg(env);
  const owner = await openOwner(opts);
  let found: {
    tenantId: string;
    offeringId: string;
    itemId: string | null;
    moduleId: string | null;
    email: string;
  };
  try {
    const tenant = await owner.query<{ id: string }>('SELECT id FROM lms.tenants WHERE slug = $1', [
      opts.slug,
    ]);
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error(`there is no college ${opts.slug}: run pnpm demo:seed first`);
    const offering = await owner.query<{ id: string; email: string }>(
      `SELECT o.id, u.email FROM lms.course_offerings o
         JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
         JOIN lms.course_participants p ON p.tenant_id = o.tenant_id AND p.offering_id = o.id
              AND p.participation = 'instructor' AND p.status = 'active'
         JOIN lms.member_identity u ON u.tenant_id = p.tenant_id AND u.membership_id = p.membership_id
              AND NOT u.erased
        WHERE o.tenant_id = $1 AND c.code = $2 LIMIT 1`,
      [tenantId, opts.course],
    );
    if (!offering.rows[0]) throw new Error(`no course ${opts.course} with an instructor`);
    const offeringId = offering.rows[0].id;
    const items = await owner.query<{ id: string; title: string }>(
      `SELECT i.id, i.title FROM lms.content_items i
         JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
        WHERE i.tenant_id = $1 AND m.offering_id = $2 AND i.kind = 'video'
          AND i.deleted_at IS NULL ORDER BY i.title`,
      [tenantId, offeringId],
    );
    const item = items.rows.find((i) => i.id === opts.item || i.title === opts.item);
    let moduleId: string | null = null;
    if (!item) {
      const modules = await owner.query<{ id: string }>(
        `SELECT id FROM lms.content_modules
          WHERE tenant_id = $1 AND offering_id = $2 AND title = $3 AND deleted_at IS NULL`,
        [tenantId, offeringId, opts.module ?? null],
      );
      moduleId = modules.rows[0]?.id ?? null;
      if (!moduleId) {
        throw new Error(
          `no video item "${opts.item}" in ${opts.course}. Video items: ${
            items.rows.map((i) => `"${i.title}"`).join(', ') || 'none'
          }. To make a new one, add --module "<module title>".`,
        );
      }
    }
    found = {
      tenantId,
      offeringId,
      itemId: item?.id ?? null,
      moduleId,
      email: offering.rows[0].email,
    };
  } finally {
    await owner.end();
  }
  const state = readState(env, opts.slug);
  if (!state)
    throw new Error(`no saved sign-in for ${opts.slug} in ${stateDir(env)}: run pnpm demo:reset`);

  const runtime = await openRuntime(opts);
  const started = Date.now();
  try {
    const teacher = runtime.browser();
    await teacher.signIn(found.email, state.password);
    const videoId = await uploadLecture(
      runtime,
      found.tenantId,
      teacher,
      found.offeringId,
      file,
      log,
    );
    const O = `/offerings/${found.offeringId}`;
    let itemId = found.itemId;
    if (itemId) {
      await teacher.patch(`${O}/items/${itemId}`, { videoId });
    } else {
      const made = await teacher.post(`${O}/modules/${found.moduleId}/items`, {
        kind: 'video',
        title: opts.item,
        videoId,
        published: true,
      });
      itemId = made.id as string;
    }
    return {
      url: `${runtime.url}/offerings/${found.offeringId}/items/${itemId}`,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    await runtime.close();
  }
}
