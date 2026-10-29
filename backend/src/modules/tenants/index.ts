// Public interface of the tenants module: the ONLY file other modules (and the composition root) may import.
export { createTenantsController, type TenantsController } from './tenants.controller';
export * from './tenants.errors';
export { createTenantsHandlers } from './tenants.handlers';
export {
  createTenantsPlatformRepository,
  type TenantsPlatformRepository,
} from './tenants.platform.repository';
export {
  createTenantsPlatformService,
  type PlatformConfig,
  type TenantsPlatformService,
} from './tenants.platform.service';
export { createTenantsRepository, type TenantsRepository } from './tenants.repository';
export { createTenantsRoutes } from './tenants.routes';
export {
  createTenantsService,
  type Tenant,
  type TenantCacheOptions,
  type TenantSetting,
  type TenantsService,
} from './tenants.service';
