import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FilesController, StorageController } from './files.controller';
import * as s from './files.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic.
export function createFilesRoutes(deps: {
  filesController: FilesController;
}): FastifyPluginAsyncTypebox {
  const { filesController: c } = deps;
  return async (app) => {
    app.post(
      '/offerings/:id/files',
      {
        config: { permission: 'course.edit', scope: 'offering' },
        schema: s.requestUploadRouteSchema,
      },
      c.requestUpload,
    );
    // the uploader confirms their own file; the service checks `created_by` (and the offering was checked
    // when the upload was requested)
    app.post(
      '/files/:id/confirm',
      { config: { authenticated: true }, schema: s.confirmUploadRouteSchema },
      c.confirm,
    );
  };
}

/**
 * The local storage driver's endpoints (development; refused in production by the env policy). Public
 * because the URL IS the credential (signature + expiry); CSRF still applies to the PUT (Origin and
 * X-Requested-With), and both routes are rate limited.
 */
export function createStorageRoutes(deps: {
  storageController: StorageController;
  /** The largest body a PUT may carry (the signed limit is checked per URL). */
  maxBytes: number;
}): FastifyPluginAsyncTypebox {
  const { storageController: c, maxBytes } = deps;
  return async (app) => {
    // an upload is the raw file in any content type: hand the request stream to the controller untouched
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    app.put(
      '/storage/upload/:token',
      {
        config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
        bodyLimit: maxBytes + 1024,
        schema: s.storageUploadRouteSchema,
      },
      c.upload,
    );
    app.get(
      '/storage/download/:token',
      {
        config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: s.storageDownloadRouteSchema,
      },
      c.download,
    );
  };
}
