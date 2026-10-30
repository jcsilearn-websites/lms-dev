import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FileParamsSchema, RequestUploadSchema } from '../../contracts';
import { contextFrom } from '../../core/context';
import { BadRequestError, NotFoundError } from '../../core/errors';
import { contentDisposition, type LocalStorage, TooLargeError } from '../../core/storage';
import { FileTooLargeError, StorageLinkInvalidError } from './files.errors';
import type { FilesService, Row } from './files.service';

// Reads the validated request, calls the service, maps the row to the response DTO.
export function toFileDto(r: Row) {
  return {
    id: r.id as string,
    name: r.original_name as string,
    contentType: r.content_type as string,
    size: Number(r.size),
    status: r.status as 'pending' | 'ready',
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export function createFilesController(deps: { filesService: FilesService; maxBytes: number }) {
  const { filesService: svc, maxBytes } = deps;
  return {
    requestUpload: async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Static<typeof RequestUploadSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const r = await svc.requestUpload(contextFrom(request), request.params.id, request.body);
      return reply.code(201).send({
        file: toFileDto(r.row),
        upload: { ...r.upload, expiresAt: r.upload.expiresAt.toISOString() },
        maxBytes: r.maxBytes,
      });
    },
    confirm: async (request: FastifyRequest<{ Params: Static<typeof FileParamsSchema> }>) =>
      toFileDto(await svc.confirm(contextFrom(request), request.params.id)),
    maxBytes,
  };
}
export type FilesController = ReturnType<typeof createFilesController>;

// ---------------------------------------------------------------------------------------------------
// The local storage driver's URLs (development). A URL is a capability: signature + expiry + limits, and
// it only works on the college it was issued for.

const mediaType = (header: string | undefined) =>
  (header ?? '').split(';')[0]?.trim().toLowerCase();

export function createStorageController(deps: { storage: LocalStorage }) {
  const { storage } = deps;
  const tenantOf = (request: FastifyRequest): string => {
    const id = request.tenant?.id;
    if (!id) throw new NotFoundError('not_found', 'Not found');
    return id;
  };
  return {
    upload: async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const claims = storage.verify(request.params.token, 'put');
      if (!claims?.k.startsWith(`${tenantOf(request)}/`)) throw new StorageLinkInvalidError();
      const max = claims.m ?? 0;
      // refuse BEFORE reading a byte when the announced length is already too large (a clean 413)
      const announced = Number(request.headers['content-length']);
      if (!Number.isFinite(announced) || announced <= 0) {
        throw new BadRequestError('length_required', 'The upload needs a Content-Length');
      }
      if (announced > max) {
        void reply.header('connection', 'close');
        throw new FileTooLargeError(max);
      }
      if (mediaType(request.headers['content-type']) !== claims.c) {
        throw new BadRequestError(
          'content_type_mismatch',
          'The upload declares another content type',
        );
      }
      try {
        await storage.write(claims.k, request.body as NodeJS.ReadableStream as never, max);
      } catch (err) {
        if (err instanceof TooLargeError) {
          void reply.header('connection', 'close');
          throw new FileTooLargeError(max);
        }
        throw err;
      }
      return reply.code(204).send();
    },

    download: async (
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply,
    ) => {
      const claims = storage.verify(request.params.token, 'get');
      if (!claims?.k.startsWith(`${tenantOf(request)}/`)) throw new StorageLinkInvalidError();
      const object = await storage.read(claims.k);
      if (!object) throw new NotFoundError('file_not_found', 'The file does not exist');
      const { n, i } = JSON.parse(claims.d ?? '{}') as { n?: string; i?: boolean };
      void reply
        .header('content-type', claims.c ?? 'application/octet-stream')
        .header('content-length', String(object.size))
        .header('content-disposition', contentDisposition(n ?? 'file', i === true))
        // the response is data, never a page: no sniffing, no scripts, no framing, never cached by shared caches
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store');
      return reply.send(object.stream);
    },
  };
}
export type StorageController = ReturnType<typeof createStorageController>;
