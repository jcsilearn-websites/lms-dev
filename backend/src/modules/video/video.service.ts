import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { MAX_CAPTIONS_PER_VIDEO } from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { BadRequestError, ForbiddenError } from '../../core/errors';
import { cleanFileName, type LocalStorage } from '../../core/storage';
import { newId } from '../../core/uuid';
import {
  ALLOWED_EXTENSIONS,
  type AssetRef,
  assetPrefix,
  codecString,
  DEFAULT_PROBE_LIMITS,
  extensionOf,
  FfmpegAbortedError,
  FfmpegFailedError,
  type MasterEntry,
  masterPlaylist,
  outputFps,
  type PlaybackSession,
  type PlaybackTokens,
  type Probe,
  parseRange,
  parseSegments,
  planRenditions,
  posterArgs,
  probeFile,
  progressSeconds,
  resolvePlaybackPath,
  run,
  type Served,
  sourceKey,
  thumbnailArgs,
  transcodeArgs,
  type VideoProvider,
  VideoRejectedError,
  VideoUnavailableError,
} from '../../core/video';
import type { Database } from '../../db/client';
import { type AccessSpec, assertAccess, OfferingArchivedError } from '../courses';
import type { JobsService } from '../jobs';
import {
  CaptionInvalidError,
  CaptionNotFoundError,
  PlaybackLinkInvalidError,
  TooManyCaptionsError,
  UploadBusyError,
  UploadIncompleteError,
  UploadNotOpenError,
  UploadOffsetError,
  VideoContentMismatchError,
  VideoInUseError,
  VideoNotFoundError,
  VideoTooLargeError,
  VideoTypeNotAllowedError,
  VideoUnavailable,
} from './video.errors';
import type { Row, VideoRepository } from './video.repository';
import { validateWebVtt } from './video.vtt';

export type { Row } from './video.repository';

export interface VideoConfig {
  maxBytes: number;
  maxDurationSeconds: number;
  chunkBytes: number;
  playbackTtlSeconds: number;
  sourceRetentionDays: number;
  graceHours: number;
  workDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  timeoutFactor: number;
  threads: number;
  purgeEveryMs: number;
}

/** What the local provider adds: reading the files it serves and writing the files the worker produces. */
export interface LocalVideoDeps {
  storage: LocalStorage;
  tokens: PlaybackTokens;
}

/** The part of a job context the transcoder needs. */
export interface ProcessContext {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
}

export interface PlaybackFile {
  status: 200 | 206 | 416;
  served: Served;
  size: number;
  start: number;
  end: number;
  stream: Readable | null;
}

const THUMBNAILS = 5;
/** A file whose first bytes are none of these is not a video of the claimed type. */
function looksLikeVideo(head: Buffer, ext: string): boolean {
  if (ext === '.mkv' || ext === '.webm') {
    return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
  }
  // ISO base media / QuickTime: a box whose type is at bytes 4..8
  if (head.length < 12) return false;
  const type = head.toString('latin1', 4, 8);
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(type);
}

export function createVideoService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  videoRepo: VideoRepository;
  provider: VideoProvider;
  /** present for the local provider (serving and transcoding use the local disk) */
  local?: LocalVideoDeps | undefined;
  jobs: Pick<JobsService, 'notifyEnqueued'>;
  config: VideoConfig;
}) {
  const { db, videoRepo, provider, local, jobs, config } = deps;
  /** videos with a chunk being written right now (one writer per upload) */
  const writing = new Set<string>();

  const spec = (ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      offeringId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  };
  const mayEdit = (acc: Parameters<typeof assertAccess>[0]) => {
    const a = assertAccess(acc);
    if (a.status === 'archived') throw new OfferingArchivedError();
    return a;
  };
  /** A provider that is not built yet answers 503 instead of 500. */
  async function providerCall<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VideoUnavailableError) throw new VideoUnavailable();
      throw err;
    }
  }
  const refOf = (tenantId: string, assetId: string): AssetRef => ({ tenantId, assetId });
  /** How far the upload really got: the storage is the truth (a chunk may have been cut off half way). */
  const storedBytes = async (ref: AssetRef): Promise<number> =>
    (await local?.storage.sizeOf(sourceKey(ref))) ?? 0;

  async function withOffset(row: Row, tenantId: string): Promise<Row> {
    if (row.status !== 'uploading') return row;
    return { ...row, uploadOffset: await storedBytes(refOf(tenantId, row.id as string)) };
  }

  return {
    // ---------------------------------------------------------------- upload (instructors)
    /** Records the video and tells the browser how to send it. */
    async createUpload(
      ctx: RequestContext,
      offeringId: string,
      input: { fileName: string; size: number },
    ) {
      const name = cleanFileName(input.fileName);
      if (!name || !(ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
        throw new VideoTypeNotAllowedError();
      }
      if (input.size > config.maxBytes) throw new VideoTooLargeError(config.maxBytes);
      const a = spec(ctx, offeringId, 'course.edit');
      const id = newId();
      const ref = refOf(a.tenantId, id);
      const r = await db.withTenant(a.tenantId, (tx) =>
        videoRepo.createAsset(
          tx,
          a,
          {
            id,
            fileName: name,
            size: input.size,
            provider: provider.kind,
            sourceKey: sourceKey(ref),
          },
          ctx.userId,
        ),
      );
      mayEdit(r.acc);
      if (!r.row) throw new VideoNotFoundError();
      const upload = await providerCall(() =>
        provider.createUpload({ ...ref, fileName: name, size: input.size }),
      );
      return { row: r.row, upload, maxBytes: config.maxBytes };
    },

    async getVideo(ctx: RequestContext, offeringId: string, videoId: string): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await db.withTenant(a.tenantId, (tx) => videoRepo.getAsset(tx, a, videoId));
      assertAccess(r.acc);
      if (!r.row) throw new VideoNotFoundError();
      return withOffset(r.row, a.tenantId);
    },

    /** The resume point: where the next chunk must start. */
    async uploadOffset(ctx: RequestContext, offeringId: string, videoId: string) {
      const row = await this.getVideo(ctx, offeringId, videoId);
      return {
        uploadOffset: Number(row.uploadOffset),
        size: Number(row.size),
        status: row.status as string,
      };
    },

    /**
     * One chunk of the file. Checked before a byte is read: the caller may edit the offering, the upload is open,
     * the chunk starts exactly where the stored bytes end (a retry after a dropped connection asks for that
     * offset first) and does not run past the announced size. One database statement, 4 round trips.
     */
    async appendChunk(
      ctx: RequestContext,
      offeringId: string,
      videoId: string,
      chunk: { offset: number; length: number; body: Readable },
    ) {
      if (!provider.appendChunk) throw new VideoUnavailable();
      const a = spec(ctx, offeringId, 'course.edit');
      const ref = refOf(a.tenantId, videoId);
      if (writing.has(videoId)) throw new UploadBusyError();
      const r = await db.withTenant(a.tenantId, (tx) => videoRepo.touchUpload(tx, a, videoId));
      mayEdit(r.acc);
      if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0) {
        throw new BadRequestError(
          'upload_offset_required',
          'The chunk needs an Upload-Offset header',
        );
      }
      if (!Number.isSafeInteger(chunk.length) || chunk.length <= 0) {
        throw new BadRequestError('length_required', 'The chunk needs a Content-Length');
      }
      if (!r.row) throw new VideoNotFoundError();
      if (!r.open) throw new UploadNotOpenError();
      const size = Number(r.row.size);
      const stored = await storedBytes(ref);
      if (chunk.offset !== stored) throw new UploadOffsetError(stored);
      if (
        chunk.length <= 0 ||
        chunk.length > config.chunkBytes ||
        chunk.offset + chunk.length > size
      ) {
        throw new UploadOffsetError(stored);
      }
      writing.add(videoId);
      try {
        const written = await providerCall(
          () =>
            provider.appendChunk?.({
              ...ref,
              offset: chunk.offset,
              body: chunk.body,
              maxBytes: chunk.length,
            }) ?? Promise.resolve(0),
        );
        const offset = chunk.offset + written;
        // the first bytes decide what the file is: a renamed document never gets further than its first chunk
        if (chunk.offset === 0 && local) {
          const head = await local.storage.readRange(sourceKey(ref), { start: 0, end: 63 });
          const bytes = head ? Buffer.concat(await collect(head.stream)) : Buffer.alloc(0);
          if (!looksLikeVideo(bytes, extensionOf(r.row.fileName as string))) {
            await provider.deleteAsset(ref);
            throw new VideoContentMismatchError();
          }
        }
        return { uploadOffset: offset, size, status: 'uploading' };
      } finally {
        writing.delete(videoId);
      }
    },

    /** The whole file is there: processing starts (the worker probes, transcodes and publishes it). */
    async complete(
      ctx: RequestContext,
      offeringId: string,
      videoId: string,
    ): Promise<{ row: Row; queued: boolean }> {
      const a = spec(ctx, offeringId, 'course.edit');
      const stored = await storedBytes(refOf(a.tenantId, videoId));
      const r = await db.withTenant(a.tenantId, (tx) =>
        videoRepo.markUploaded(tx, a, videoId, stored),
      );
      mayEdit(r.acc);
      if (!r.before) throw new VideoNotFoundError();
      if (r.row) {
        jobs.notifyEnqueued('video'); // committed: wake an in-process worker
        return { row: r.row, queued: true };
      }
      if (r.before.status === 'uploading') throw new UploadIncompleteError(stored);
      // already processing / ready / failed: asking twice is not an error
      return { row: await this.getVideo(ctx, offeringId, videoId), queued: false };
    },

    async deleteVideo(ctx: RequestContext, offeringId: string, videoId: string): Promise<void> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await db.withTenant(a.tenantId, (tx) => videoRepo.deleteAsset(tx, a, videoId));
      mayEdit(r.acc);
      if (!r.found) throw new VideoNotFoundError();
      if (r.used) throw new VideoInUseError();
      await providerCall(() => provider.deleteAsset(refOf(a.tenantId, videoId)));
    },

    // ---------------------------------------------------------------- captions
    async addCaption(
      ctx: RequestContext,
      offeringId: string,
      videoId: string,
      input: { language: string; label: string; content: string },
    ): Promise<Row> {
      const v = validateWebVtt(input.content);
      if (!v.ok) throw new CaptionInvalidError(v.message);
      const a = spec(ctx, offeringId, 'course.edit');
      if (!local) throw new VideoUnavailable();
      const key = `${assetPrefix(refOf(a.tenantId, videoId))}/captions/${input.language}.vtt`;
      const bytes = Buffer.from(v.text, 'utf8');
      const r = await db.withTenant(a.tenantId, (tx) =>
        videoRepo.upsertCaption(
          tx,
          a,
          videoId,
          {
            id: newId(),
            language: input.language,
            label: input.label.trim(),
            size: bytes.length,
            key,
          },
          ctx.userId,
          MAX_CAPTIONS_PER_VIDEO,
        ),
      );
      mayEdit(r.acc);
      if (!r.found) throw new VideoNotFoundError();
      if (r.full || !r.row) throw new TooManyCaptionsError(MAX_CAPTIONS_PER_VIDEO);
      const dir = path.join(config.workDir, `caption-${newId()}`);
      try {
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, 'caption.vtt');
        await writeFile(file, bytes);
        await local.storage.putFile(key, file);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return r.row;
    },

    async deleteCaption(
      ctx: RequestContext,
      offeringId: string,
      videoId: string,
      language: string,
    ): Promise<void> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await db.withTenant(a.tenantId, (tx) =>
        videoRepo.deleteCaption(tx, a, videoId, language),
      );
      mayEdit(r.acc);
      if (!r.deleted) throw new CaptionNotFoundError();
      await local?.storage.remove([
        `${assetPrefix(refOf(a.tenantId, videoId))}/captions/${language}.vtt`,
      ]);
    },

    // ---------------------------------------------------------------- playback
    /**
     * A short-lived playback session for a READY video the caller has been authorised to open (the content
     * module decided that in the same statement as the item lookup).
     */
    createPlayback(
      ctx: RequestContext,
      v: {
        assetId: string;
        durationMs: number;
        renditions: { name: string; height: number }[];
        captions: { language: string; label: string }[];
      },
    ) {
      if (!ctx.tenantId) throw new ForbiddenError();
      const s: PlaybackSession = (() => {
        try {
          return provider.createPlayback({
            tenantId: ctx.tenantId,
            assetId: v.assetId,
            userId: ctx.userId,
            ttlSeconds: config.playbackTtlSeconds,
          });
        } catch (err) {
          if (err instanceof VideoUnavailableError) throw new VideoUnavailable();
          throw err;
        }
      })();
      return {
        manifestUrl: s.manifestUrl,
        posterUrl: s.posterUrl,
        expiresAt: s.expiresAt.toISOString(),
        durationMs: v.durationMs,
        captions: v.captions.map((c) => ({
          language: c.language,
          label: c.label,
          url: `${s.baseUrl}/captions/${c.language}.vtt`,
        })),
        renditions: v.renditions.map((r) => ({ name: r.name, height: r.height })),
      };
    },

    /**
     * Serves one file of a playback session (local provider). The token must be genuine and unexpired, issued to
     * THIS user for THIS tenant and THIS asset (the id is also in the URL); the path must be on the allow list.
     * No database access: the signature is the authorisation, the session cookie only proves who is asking.
     */
    async openPlaybackFile(input: {
      tenantId: string | null;
      userId: string | null;
      token: string;
      assetId: string;
      rel: string;
      range: string | undefined;
    }): Promise<PlaybackFile> {
      if (!local) throw new VideoUnavailable();
      const claims = local.tokens.verify(input.token);
      if (
        !claims ||
        !input.tenantId ||
        !input.userId ||
        claims.t !== input.tenantId ||
        claims.u !== input.userId ||
        claims.a !== input.assetId
      ) {
        throw new PlaybackLinkInvalidError();
      }
      const served = resolvePlaybackPath(refOf(claims.t, claims.a), input.rel);
      if (!served) throw new VideoNotFoundError();
      const size = await local.storage.sizeOf(served.key);
      if (size === null) throw new VideoNotFoundError();
      const range = parseRange(input.range, size);
      if (range.kind === 'unsatisfiable') {
        return { status: 416, served, size, start: 0, end: 0, stream: null };
      }
      const part = await local.storage.readRange(
        served.key,
        range.kind === 'range' ? { start: range.start, end: range.end } : undefined,
      );
      if (!part) throw new VideoNotFoundError();
      return {
        status: range.kind === 'range' ? 206 : 200,
        served,
        size,
        start: part.start,
        end: part.end,
        stream: part.stream,
      };
    },

    // ---------------------------------------------------------------- the worker
    /**
     * Probes, transcodes and publishes one uploaded video. Safe to run again: the output is built in the job's own
     * directory and moved into place only when complete, so a retry after a crash or a shutdown starts from
     * scratch. A rejected input marks the video failed (with a reason for the uploader) and the job succeeds;
     * an ffmpeg problem that is not the input's fault is thrown, so the queue retries it.
     */
    async process(
      tenantId: string,
      assetId: string,
      job: ProcessContext,
    ): Promise<Record<string, number>> {
      if (!local || !provider.processesInWorker) return { skipped: 1 };
      const row = await db.withTenant(tenantId, (tx) =>
        videoRepo.findForProcessing(tx, tenantId, assetId),
      );
      if (!row) return { missing: 1 };
      if (row.status !== 'processing') return { skipped: 1 };
      const ref = refOf(tenantId, assetId);
      const base = assetPrefix(ref);
      const workDir = path.resolve(config.workDir, job.jobId);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const fail = async (code: string, message: string) => {
        await db.withTenant(tenantId, (tx) =>
          videoRepo.markFailed(tx, tenantId, assetId, { code, message }),
        );
        return { failed: 1 };
      };
      try {
        const input = local.storage.pathOf(sourceKey(ref));
        const probe: Probe = await probeFile(
          config.ffprobePath,
          input,
          row.original_name as string,
          { ...DEFAULT_PROBE_LIMITS, maxDurationSeconds: config.maxDurationSeconds },
          job.signal,
        );
        const renditions = planRenditions(probe.width, probe.height);
        const durationMs = Math.max(1, Math.round(probe.durationSeconds * 1000));
        await db.withTenant(tenantId, (tx) =>
          videoRepo.setProbed(tx, tenantId, assetId, {
            container: probe.container,
            durationMs,
            width: probe.width,
            height: probe.height,
            hasAudio: probe.hasAudio,
            sourceMeta: {
              formatName: probe.formatName,
              videoCodec: probe.videoCodec,
              audioCodec: probe.audioCodec,
              fps: Math.round(probe.fps * 100) / 100,
              bitRate: probe.bitRate,
            },
            renditions: renditions.map((r) => ({
              name: r.name,
              width: r.width,
              height: r.height,
              videoKbps: r.videoKbps,
              bytes: 0,
            })),
          }),
        );

        const outDir = path.join(workDir, 'hls');
        for (const r of renditions) await mkdir(path.join(outDir, r.name), { recursive: true });
        const timeoutMs = Math.max(600_000, config.timeoutFactor * probe.durationSeconds * 1000);
        let lastPercent = 0;
        let lastWrite = Date.now();
        let chain: Promise<unknown> = Promise.resolve();
        await run(
          config.ffmpegPath,
          transcodeArgs({ input, outDir, workDir, probe, renditions, threads: config.threads }),
          {
            signal: job.signal,
            timeoutMs,
            cwd: workDir,
            onStdoutLine: (line) => {
              const s = progressSeconds(line);
              if (s === null) return;
              // 95% = the encode; the rest is the poster, the thumbnails and publishing
              const percent = Math.min(95, Math.floor((s / probe.durationSeconds) * 95));
              if (percent < lastPercent + 3 && Date.now() - lastWrite < 2000) return;
              if (percent <= lastPercent) return;
              lastPercent = percent;
              lastWrite = Date.now();
              chain = chain
                .then(() =>
                  db.withTenant(tenantId, (tx) =>
                    videoRepo.setProgress(tx, tenantId, assetId, percent),
                  ),
                )
                .catch(() => undefined);
            },
          },
        );
        await chain;

        const poster = path.join(workDir, 'poster.jpg');
        await run(config.ffmpegPath, posterArgs(input, poster, workDir, probe.durationSeconds), {
          signal: job.signal,
          timeoutMs: 120_000,
          cwd: workDir,
        });
        const thumbs = path.join(workDir, 'thumbs');
        await mkdir(thumbs, { recursive: true });
        await run(
          config.ffmpegPath,
          thumbnailArgs(input, thumbs, workDir, probe.durationSeconds, THUMBNAILS),
          { signal: job.signal, timeoutMs: 120_000, cwd: workDir },
        );

        // what was really produced: sizes per rendition and the master playlist built from them
        const sized: {
          name: string;
          width: number;
          height: number;
          videoKbps: number;
          bytes: number;
        }[] = [];
        const entries: MasterEntry[] = [];
        const fps = outputFps(probe.fps);
        for (const r of renditions) {
          const dir = path.join(outDir, r.name);
          const files = await readdir(dir);
          if (!files.includes('init.mp4') || !files.some((f) => f.endsWith('.m4s'))) {
            throw new FfmpegFailedError('the transcode produced no segments', '');
          }
          let bytes = 0;
          for (const f of files) bytes += (await stat(path.join(dir, f))).size;
          const segments = parseSegments(await readFile(path.join(dir, 'index.m3u8'), 'utf8'));
          let seconds = 0;
          let peak = 0;
          for (const seg of segments) {
            const size = (await stat(path.join(dir, seg.name))).size;
            seconds += seg.seconds;
            peak = Math.max(peak, (size * 8) / seg.seconds);
          }
          sized.push({
            name: r.name,
            width: r.width,
            height: r.height,
            videoKbps: r.videoKbps,
            bytes,
          });
          entries.push({
            rendition: r,
            codecs: codecString(r, fps, probe.hasAudio),
            fps,
            peakBps: peak,
            averageBps: seconds > 0 ? (bytes * 8) / seconds : peak,
          });
        }
        await writeFile(path.join(outDir, 'master.m3u8'), masterPlaylist(entries));

        // publish: everything the player needs is moved into place only now
        await local.storage.replacePrefix(`${base}/hls`, outDir);
        await local.storage.replacePrefix(`${base}/thumbs`, thumbs);
        await local.storage.putFile(`${base}/poster.jpg`, poster);
        const ready = await db.withTenant(tenantId, (tx) =>
          videoRepo.markReady(tx, tenantId, assetId, {
            renditions: sized,
            hlsPrefix: `${base}/hls`,
            posterKey: `${base}/poster.jpg`,
            retentionDays: config.sourceRetentionDays,
          }),
        );
        if (!ready) await local.storage.removePrefix(base); // deleted while it was being processed
        return { renditions: sized.length };
      } catch (err) {
        if (err instanceof FfmpegAbortedError || job.signal.aborted) throw err;
        if (err instanceof VideoRejectedError) return fail(err.code, err.message);
        if (
          err instanceof FfmpegFailedError &&
          /Invalid data|moov atom|Error while decoding|corrupt|Truncated/i.test(err.stderr)
        ) {
          return fail(
            'corrupt',
            'The video looks damaged and could not be converted. Try exporting it again.',
          );
        }
        if (job.attempt >= job.maxAttempts) {
          return fail(
            'processing_failed',
            'We could not convert this video. Try uploading it again.',
          );
        }
        throw err;
      } finally {
        await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },

    // ---------------------------------------------------------------- sweeps (worker)
    /** Deletes videos nothing references (abandoned uploads, unused videos) past the grace period. */
    async purgeUnreferenced(limit = 200): Promise<number> {
      const gone = await db.withoutTenant((conn) =>
        videoRepo.purge(conn, config.graceHours, limit),
      );
      for (const g of gone) {
        await provider.deleteAsset({ tenantId: g.tenantId, assetId: g.id }).catch(() => undefined);
      }
      return gone.length;
    },

    /**
     * Removes scratch directories a crashed worker left behind (a job's own directory is removed when the job
     * ends, however it ends; only a killed process skips that). Anything untouched for `olderThanHours`.
     */
    async sweepWorkDir(olderThanHours = 6): Promise<number> {
      let removed = 0;
      const root = path.resolve(config.workDir);
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return 0; // no scratch directory yet
      }
      for (const name of names) {
        const dir = path.join(root, name);
        const info = await stat(dir).catch(() => null);
        if (!info?.isDirectory() || Date.now() - info.mtimeMs < olderThanHours * 3_600_000)
          continue;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        removed++;
      }
      return removed;
    },

    /** Deletes the originals that are past their retention (a re-transcode then needs a new upload). */
    async expireSources(limit = 200): Promise<number> {
      const due = await db.withoutTenant((conn) => videoRepo.expireSources(conn, limit));
      if (local) {
        for (const d of due) await local.storage.remove([sourceKey(refOf(d.tenantId, d.id))]);
      }
      return due.length;
    },
  };
}
export type VideoService = ReturnType<typeof createVideoService>;

async function collect(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return chunks;
}
