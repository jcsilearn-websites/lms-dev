// Public interface of the profiles module: the ONLY file other modules (and the composition root) may import.
export {
  createProfilesController,
  type ProfilesController,
  toProfileDto,
} from './profiles.controller';
export * from './profiles.errors';
export { createProfilesHandlers } from './profiles.handlers';
export { createProfilesRepository, type ProfilesRepository } from './profiles.repository';
export { createProfilesRoutes } from './profiles.routes';
export {
  createProfilesService,
  type MoveOutcome,
  type ProfileInput,
  type ProfilesService,
} from './profiles.service';
