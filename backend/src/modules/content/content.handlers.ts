import type { HandlerMap } from '../../core/handlers';
import type { ContentService } from './content.service';

// Background-job handlers for this module, run by the worker. They call the module's service only.
export function createContentHandlers(deps: { contentService: ContentService }): HandlerMap {
  const { contentService } = deps;
  return {
    // Copies a large offering's content (queued by POST /offerings/:id/copy).
    'content.copy': {
      run: async (payload, ctx) => {
        if (!ctx.tenantId) throw new Error('content.copy needs a tenant');
        const p = payload as { sourceId: string; targetId: string; actorUserId: string };
        return contentService.runCopy(ctx.tenantId, p, {
          number: ctx.attempt,
          max: ctx.maxAttempts,
        });
      },
    },
  };
}
