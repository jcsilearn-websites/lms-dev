// Public interface of the video module: the ONLY file other modules (and the composition root) may import.
export {
  createPlaybackController,
  createVideoController,
  type PlaybackController,
  type VideoController,
} from './video.controller';
export * from './video.errors';
export { createVideoHandlers } from './video.handlers';
export { createVideoRepository, type VideoRepository } from './video.repository';
export { createPlaybackRoutes, createVideoRoutes, createVideoUploadRoutes } from './video.routes';
export {
  createVideoService,
  type LocalVideoDeps,
  type VideoConfig,
  type VideoService,
} from './video.service';
export { validateWebVtt } from './video.vtt';
