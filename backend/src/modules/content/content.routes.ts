import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { ContentController } from './content.controller';
import * as s from './content.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Every route is offering-scoped: the
// service decides in the same statement as the work whether the caller takes part (404 if not) and may do it.
const view = { permission: 'content.view', scope: 'offering' } as const;
const edit = { permission: 'course.edit', scope: 'offering' } as const;

export function createContentRoutes(deps: {
  contentController: ContentController;
}): FastifyPluginAsyncTypebox {
  const { contentController: c } = deps;
  return async (app) => {
    app.get('/offerings/:id/outline', { config: view, schema: s.outlineRouteSchema }, c.outline);
    app.get(
      '/offerings/:id/items/:itemId',
      { config: view, schema: s.getItemRouteSchema },
      c.getItem,
    );
    app.get(
      '/offerings/:id/items/:itemId/download',
      { config: view, schema: s.downloadItemRouteSchema },
      c.downloadFile,
    );
    app.post(
      '/offerings/:id/items/:itemId/playback',
      { config: view, schema: s.playbackRouteSchema },
      c.playback,
    );

    app.post(
      '/offerings/:id/modules',
      { config: edit, schema: s.createModuleRouteSchema },
      c.createModule,
    );
    app.patch(
      '/offerings/:id/modules/:moduleId',
      { config: edit, schema: s.updateModuleRouteSchema },
      c.updateModule,
    );
    app.post(
      '/offerings/:id/modules/:moduleId/move',
      { config: edit, schema: s.moveModuleRouteSchema },
      c.moveModule,
    );
    app.delete(
      '/offerings/:id/modules/:moduleId',
      { config: edit, schema: s.deleteModuleRouteSchema },
      c.deleteModule,
    );

    app.post(
      '/offerings/:id/modules/:moduleId/items',
      { config: edit, schema: s.createItemRouteSchema },
      c.createItem,
    );
    app.patch(
      '/offerings/:id/items/:itemId',
      { config: edit, schema: s.updateItemRouteSchema },
      c.updateItem,
    );
    app.post(
      '/offerings/:id/items/:itemId/move',
      { config: edit, schema: s.moveItemRouteSchema },
      c.moveItem,
    );
    app.delete(
      '/offerings/:id/items/:itemId',
      { config: edit, schema: s.deleteItemRouteSchema },
      c.deleteItem,
    );

    app.post(
      '/offerings/:id/copy',
      { config: { permission: 'course.publish', scope: 'offering' }, schema: s.copyRouteSchema },
      c.copy,
    );
  };
}
