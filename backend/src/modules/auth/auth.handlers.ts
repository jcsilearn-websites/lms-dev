import type { HandlerMap } from '../../core/handlers';
import type { PurgeConfig } from '../sessions';
import type { MfaService } from './auth.mfa.service';
import type { MfaResetService } from './auth.mfa-reset.service';
import type { AuthService } from './auth.service';

/** how late after its time an approved reset may run */
export const MFA_RESET_SCAN_MS = 5 * 60_000;

// Background-job handlers for this module, run by the worker (src/worker.ts). They call the module's
// service, never the repository or the database directly.
export function createAuthHandlers(deps: {
  authService: AuthService;
  mfaService: Pick<MfaService, 'purgeChallenges'>;
  mfaResetService: Pick<MfaResetService, 'run'>;
  purge: PurgeConfig;
}): HandlerMap {
  const { authService, mfaService, mfaResetService, purge } = deps;
  return {
    // approved resets of a second factor are executed 24 hours after the approval; undecided ones expire after 7 days
    'mfa.reset_run': {
      everyMs: MFA_RESET_SCAN_MS,
      run: async () => mfaResetService.run(),
    },
    // enqueued (in the import transaction) for every member a bulk import created; queues the invite email (outbox)
    'invites.send': {
      run: async (payload, ctx) => {
        const p = payload as { membershipId?: string; userId?: string };
        if (!ctx.tenantId || !p.membershipId) {
          throw new Error('invites.send needs a tenant and a membershipId');
        }
        return authService.sendQueuedInvite(ctx.tenantId, {
          membershipId: p.membershipId,
          ...(p.userId ? { userId: p.userId } : {}),
        });
      },
    },
    'auth.purge_tokens': {
      everyMs: purge.everyMs,
      run: async () => ({
        deleted: await authService.purgeTokens({
          retentionDays: purge.retentionDays,
          batchSize: purge.batchSize,
        }),
        challenges: await mfaService.purgeChallenges(purge.batchSize),
      }),
    },
  };
}
