import type { HandlerMap } from '../../core/handlers';
import type { PrivacyService } from './privacy.service';

// Background-job handlers of this module, run by the worker (src/worker.ts). They call the service, never the repository.
export function createPrivacyHandlers(deps: {
  privacyService: PrivacyService;
  purge: { everyMs: number };
}): HandlerMap {
  const { privacyService, purge } = deps;
  return {
    // enqueued by privacy_export_request in the request's own transaction; one job per export
    'privacy.export': {
      run: async (payload, ctx) => {
        const exportId = (payload as { exportId?: string }).exportId;
        if (!ctx.tenantId || !exportId)
          throw new Error('privacy.export needs a tenant and an exportId');
        return privacyService.buildExport(ctx.tenantId, exportId, ctx);
      },
    },
    // archives are deleted 7 days after they were prepared
    'privacy.purge_exports': {
      everyMs: purge.everyMs,
      run: async () => ({ expired: await privacyService.expireExports() }),
    },
  };
}
