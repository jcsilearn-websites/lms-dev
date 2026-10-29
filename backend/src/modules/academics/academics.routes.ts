import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { AcademicsController } from './academics.controller';
import { ENTITY_KEYS, entityRouteSchemas, setCurrentRouteSchema } from './academics.schemas';

// URL + method + schemas + route declaration only; no logic. The six entities share one shape, so their
// seven routes each are registered from the entity description: reads need academic.read (every active
// member), everything else academic.manage (institution admin).
export function createAcademicsRoutes(deps: {
  academicsController: AcademicsController;
}): FastifyPluginAsyncTypebox {
  const { academicsController } = deps;
  return async (app) => {
    // the generic handlers are typed loosely (one description drives six different bodies)
    const route = app as unknown as {
      get: (url: string, opts: object, handler: never) => void;
      post: (url: string, opts: object, handler: never) => void;
      patch: (url: string, opts: object, handler: never) => void;
      delete: (url: string, opts: object, handler: never) => void;
    };
    for (const key of ENTITY_KEYS) {
      const base = `/${key}`;
      const h = academicsController.forEntity(key);
      const s = entityRouteSchemas(key);
      const read = { permission: 'academic.read' } as const;
      const manage = { permission: 'academic.manage' } as const;
      route.get(base, { config: read, schema: s.list }, h.list as never);
      route.get(`${base}/:id`, { config: read, schema: s.get }, h.get as never);
      route.post(base, { config: manage, schema: s.create }, h.create as never);
      route.patch(`${base}/:id`, { config: manage, schema: s.update }, h.update as never);
      route.post(`${base}/:id/archive`, { config: manage, schema: s.archive }, h.archive as never);
      route.post(
        `${base}/:id/unarchive`,
        { config: manage, schema: s.unarchive },
        h.unarchive as never,
      );
      route.delete(`${base}/:id`, { config: manage, schema: s.remove }, h.remove as never);
    }
    route.post(
      '/academic-years/:id/set-current',
      { config: { permission: 'academic.manage' }, schema: setCurrentRouteSchema },
      academicsController.setCurrent as never,
    );
  };
}
