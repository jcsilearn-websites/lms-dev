// Public interface of the notifications module (in-app notifications, preferences, college settings, unsubscribe, the
// reminder / digest scan): the ONLY file other modules (and the composition root) may import.
export {
  createNotificationsController,
  type NotificationsController,
} from './notifications.controller';
export { createNotificationsHandlers } from './notifications.handlers';
export {
  createNotificationsRepository,
  type NotificationsRepository,
} from './notifications.repository';
export { createNotificationsRoutes } from './notifications.routes';
export {
  createNotificationsService,
  type NotificationsConfig,
  type NotificationsService,
  unreadEtag,
} from './notifications.service';
