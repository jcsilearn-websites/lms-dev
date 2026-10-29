import type { HandlerMap } from '../../core/handlers';
import type { PurgeConfig } from '../sessions';
import type { AuthService } from './auth.service';

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly.
export function createAuthHandlers(deps: {
  authService: AuthService;
  purge: PurgeConfig;
}): HandlerMap {
  const { authService, purge } = deps;
  return {
    // enqueued (in the import transaction) for every member a bulk import created; sends the invite email
    'invites.send': {
      run: async (payload, ctx) => {
        const membershipId = (payload as { membershipId?: string }).membershipId;
        if (!ctx.tenantId || !membershipId) {
          throw new Error('invites.send needs a tenant and a membershipId');
        }
        return authService.sendQueuedInvite(ctx.tenantId, { membershipId });
      },
    },
    'auth.purge_tokens': {
      everyMs: purge.everyMs,
      run: async () => ({
        deleted: await authService.purgeTokens({
          retentionDays: purge.retentionDays,
          batchSize: purge.batchSize,
        }),
      }),
    },
  };
}
