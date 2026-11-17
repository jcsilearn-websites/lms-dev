import type { HandlerMap } from '../../core/handlers';
import type { NotificationsService } from './notifications.service';

// Scheduled system jobs: the scan (deadline reminders, quizzes opening / closing, results visible by the clock, daily
// digests and weekly summaries, each college in its own time zone) and the retention purge of read notifications.
export function createNotificationsHandlers(deps: {
  notificationsService: NotificationsService;
  scan: { everyMs: number };
  purge: { everyMs: number };
}): HandlerMap {
  const { notificationsService } = deps;
  return {
    'notifications.scan': {
      everyMs: deps.scan.everyMs,
      run: async (_payload, ctx) => notificationsService.scan({ signal: ctx.signal }),
    },
    'notifications.purge': {
      everyMs: deps.purge.everyMs,
      run: async () => ({ deleted: await notificationsService.purgeRead() }),
    },
  };
}
