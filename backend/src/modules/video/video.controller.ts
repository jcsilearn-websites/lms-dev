import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AddCaptionRequestSchema,
  CreateVideoRequestSchema,
  OfferingParamsSchema,
  OfferingVideoCaptionParamsSchema,
  OfferingVideoParamsSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import { TooLargeError } from '../../core/storage';
import { VideoTooLargeError, VideoUnavailable } from './video.errors';
import type { Row, VideoService } from './video.service';

// Reads the validated request, calls the service, maps the row to the response DTO. No DB access, no business rules.

/** Rows arrive from SQL already shaped (camelCase JSON); only the types need to be stated. */
const toVideoDto = (r: Row) => r as never;

export function createVideoController(deps: { videoService: VideoService; maxBytes: number }) {
  const { videoService: svc, maxBytes } = deps;
  type Off = { Params: Static<typeof OfferingParamsSchema> };
  type Vid = { Params: Static<typeof OfferingVideoParamsSchema> };
  return {
    create: async (
      request: FastifyRequest<Off & { Body: Static<typeof CreateVideoRequestSchema> }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.createUpload(contextFrom(request), request.params.id, request.body);
      if (r.upload.protocol !== 'chunked') throw new VideoUnavailable();
      return reply.code(201).send({
        video: toVideoDto(r.row),
        upload: { protocol: 'chunked', chunkBytes: r.upload.chunkBytes, maxBytes: r.maxBytes },
      });
    },
    get: async (request: FastifyRequest<Vid>) =>
      toVideoDto(
        await svc.getVideo(contextFrom(request), request.params.id, request.params.videoId),
      ),
    getUpload: async (request: FastifyRequest<Vid>) =>
      (await svc.uploadOffset(
        contextFrom(request),
        request.params.id,
        request.params.videoId,
      )) as never,
    appendChunk: async (request: FastifyRequest<Vid>) => {
      // the numbers are validated by the service, after it knows the caller may edit this offering
      const offset = Number(request.headers['upload-offset'] ?? Number.NaN);
      const length = Number(request.headers['content-length'] ?? Number.NaN);
      try {
        return (await svc.appendChunk(
          contextFrom(request),
          request.params.id,
          request.params.videoId,
          { offset, length, body: request.body as NodeJS.ReadableStream as never },
        )) as never;
      } catch (err) {
        if (err instanceof TooLargeError) throw new VideoTooLargeError(maxBytes);
        throw err;
      }
    },
    complete: async (request: FastifyRequest<Vid>, reply: FastifyReply) => {
      const r = await svc.complete(contextFrom(request), request.params.id, request.params.videoId);
      return reply.code(r.queued ? 202 : 200).send(toVideoDto(r.row));
    },
    remove: async (request: FastifyRequest<Vid>) => {
      await svc.deleteVideo(contextFrom(request), request.params.id, request.params.videoId);
      return { status: 'deleted' };
    },
    addCaption: async (
      request: FastifyRequest<Vid & { Body: Static<typeof AddCaptionRequestSchema> }>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(
          (await svc.addCaption(
            contextFrom(request),
            request.params.id,
            request.params.videoId,
            request.body,
          )) as never,
        ),
    deleteCaption: async (
      request: FastifyRequest<{ Params: Static<typeof OfferingVideoCaptionParamsSchema> }>,
    ) => {
      await svc.deleteCaption(
        contextFrom(request),
        request.params.id,
        request.params.videoId,
        request.params.language,
      );
      return { status: 'deleted' };
    },
  };
}
export type VideoController = ReturnType<typeof createVideoController>;

// ---------------------------------------------------------------------------------------------------
// The local provider's playback files (development / CI). Playlists, init and media segments, poster, captions.

export function createPlaybackController(deps: { videoService: VideoService }) {
  const { videoService: svc } = deps;
  return {
    serve: async (
      request: FastifyRequest<{ Params: { token: string; assetId: string; '*': string } }>,
      reply: FastifyReply,
    ) => {
      const file = await svc.openPlaybackFile({
        tenantId: request.tenant?.id ?? null,
        userId: request.auth?.userId ?? null,
        token: request.params.token,
        assetId: request.params.assetId,
        rel: request.params['*'],
        range: request.headers.range,
      });
      // the response is media, never a page. The URL carries a credential: nothing may leak it as a Referer, and
      // shared caches must not keep it.
      void reply
        .header('content-type', file.served.contentType)
        .header('accept-ranges', 'bytes')
        .header('cache-control', file.served.cacheControl)
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cross-origin-resource-policy', 'same-origin')
        .header('content-security-policy', "default-src 'none'; sandbox");
      if (file.status === 416) {
        return reply.code(416).header('content-range', `bytes */${file.size}`).send();
      }
      void reply.header('content-length', String(file.end - file.start + 1));
      if (file.status === 206) {
        void reply
          .code(206)
          .header('content-range', `bytes ${file.start}-${file.end}/${file.size}`);
      }
      return reply.send(file.stream);
    },
  };
}
export type PlaybackController = ReturnType<typeof createPlaybackController>;
