import type { HandlerMap } from '../../core/handlers';
import type { ImportsService } from './imports.service';

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly.
export function createImportsHandlers(deps: {
  importsService: ImportsService;
  /** how often the retention purge and the dead-import reaper are scheduled */
  purge: { everyMs: number };
}): HandlerMap {
  const { importsService, purge } = deps;
  return {
    // enqueued by POST /imports/:id/confirm in the confirm transaction; one job per import
    'imports.process': {
      run: async (payload, ctx) => {
        const importId = (payload as { importId?: string }).importId;
        if (!ctx.tenantId || !importId)
          throw new Error('imports.process needs a tenant and an importId');
        const r = await importsService.process(ctx.tenantId, importId, ctx);
        return { batches: r.batches, rows: r.rows };
      },
    },
    // staged rows hold names and emails: deleted IMPORT_RETENTION_DAYS after the import finished
    'imports.purge': {
      everyMs: purge.everyMs,
      run: async () => ({ deleted: await importsService.purgeRows() }),
    },
    // an import whose job was dead-lettered must not block the tenant's next import forever
    'imports.reap': {
      everyMs: 5 * 60_000,
      run: async () => ({ failed: await importsService.reapDead() }),
    },
  };
}
