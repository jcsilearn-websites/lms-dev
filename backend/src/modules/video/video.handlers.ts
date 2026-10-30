import type { HandlerMap } from '../../core/handlers';
import { isUuid } from '../../core/uuid';
import type { VideoService } from './video.service';

// Background-job handlers for this module, run by the worker. They call the module's service only.
export function createVideoHandlers(deps: {
  videoService: VideoService;
  sweep: { everyMs: number };
}): HandlerMap {
  const { videoService, sweep } = deps;
  return {
    // Queued when an upload is complete (POST .../complete): probe, transcode, publish. One at a time by default
    // (JOB_CONCURRENCY=video:N): ffmpeg uses every core it is given.
    video: {
      run: async (payload, ctx) => {
        const assetId = (payload as { assetId?: unknown } | null)?.assetId;
        if (!ctx.tenantId || typeof assetId !== 'string' || !isUuid(assetId)) {
          throw new Error('video needs a tenant and an assetId');
        }
        return videoService.process(ctx.tenantId, assetId, ctx);
      },
    },
    // Deletes videos nothing references once they are past the grace period (VIDEO_UPLOAD_GRACE_HOURS), and the
    // scratch directories of crashed transcodes.
    'video.purge': {
      everyMs: sweep.everyMs,
      run: async () => ({
        deleted: await videoService.purgeUnreferenced(),
        staleWorkDirs: await videoService.sweepWorkDir(),
      }),
    },
    // Deletes the uploaded originals VIDEO_SOURCE_RETENTION_DAYS after a successful transcode.
    'video.expire_sources': {
      everyMs: sweep.everyMs,
      run: async () => ({ expired: await videoService.expireSources() }),
    },
  };
}
