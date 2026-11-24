// Public interface of the privacy module (data protection, step 14b: "download my data"; erasure follows): the ONLY file other modules
// (and the composition root) may import.
export { buildArchive, countsOf } from './privacy.archive';
export {
  createErasureController,
  createPrivacyController,
  type ErasureController,
  type PrivacyController,
} from './privacy.controller';
export { createErasureRepository, type ErasureRepository } from './privacy.erasure.repository';
export { createErasureService, type ErasureService } from './privacy.erasure.service';
export { createPrivacyHandlers } from './privacy.handlers';
export { createPrivacyRepository, type PrivacyRepository } from './privacy.repository';
export { createPrivacyRoutes } from './privacy.routes';
export { createPrivacyService, EXPORT_TTL_SECONDS, type PrivacyService } from './privacy.service';
