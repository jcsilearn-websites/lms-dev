import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { PlaybackController, VideoController } from './video.controller';
import * as s from './video.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Every builder route is offering-scoped: the
// service decides in the same statement as the work whether the caller may edit this offering.
const edit = { permission: 'course.edit', scope: 'offering' } as const;

export function createVideoRoutes(deps: {
  videoController: VideoController;
}): FastifyPluginAsyncTypebox {
  const { videoController: c } = deps;
  return async (app) => {
    app.post('/offerings/:id/videos', { config: edit, schema: s.createVideoRouteSchema }, c.create);
    app.get(
      '/offerings/:id/videos/:videoId',
      { config: edit, schema: s.getVideoRouteSchema },
      c.get,
    );
    app.get(
      '/offerings/:id/videos/:videoId/upload',
      { config: edit, schema: s.getUploadRouteSchema },
      c.getUpload,
    );
    app.post(
      '/offerings/:id/videos/:videoId/complete',
      { config: edit, schema: s.completeVideoRouteSchema },
      c.complete,
    );
    app.delete(
      '/offerings/:id/videos/:videoId',
      { config: edit, schema: s.deleteVideoRouteSchema },
      c.remove,
    );
    app.post(
      '/offerings/:id/videos/:videoId/captions',
      { config: edit, schema: s.addCaptionRouteSchema },
      c.addCaption,
    );
    app.delete(
      '/offerings/:id/videos/:videoId/captions/:language',
      { config: edit, schema: s.deleteCaptionRouteSchema },
      c.deleteCaption,
    );
  };
}

/**
 * The chunk endpoint: its body is the raw bytes in any content type, so it lives in its own plugin (the parser
 * and the larger body limit apply to it only).
 */
export function createVideoUploadRoutes(deps: {
  videoController: VideoController;
  chunkBytes: number;
}): FastifyPluginAsyncTypebox {
  const { videoController: c, chunkBytes } = deps;
  return async (app) => {
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    app.patch(
      '/offerings/:id/videos/:videoId/upload',
      {
        config: { ...edit, rateLimit: { max: 1200, timeWindow: '1 minute' } },
        bodyLimit: chunkBytes + 1024,
        schema: s.appendChunkRouteSchema,
      },
      c.appendChunk,
    );
  };
}

/**
 * Local provider only (development / CI; refused in production by the env policy). The URL carries the playback
 * token; the session cookie must belong to the user the token was issued to.
 */
export function createPlaybackRoutes(deps: {
  playbackController: PlaybackController;
}): FastifyPluginAsyncTypebox {
  const { playbackController: c } = deps;
  return async (app) => {
    app.get(
      '/video/play/:token/:assetId/*',
      {
        config: { authenticated: true, rateLimit: { max: 3000, timeWindow: '1 minute' } },
        schema: s.playbackFileRouteSchema,
      },
      c.serve,
    );
  };
}
