// Shared API contracts. The ONLY backend entrypoint the frontend may import
// (package.json "exports": "./contracts"). Keep this folder free of Node/server dependencies.
export * from './academics';
export * from './audit';
export * from './auth';
export * from './errors';
export * from './health';
export * from './imports';
export * from './members';
export * from './platform';
export * from './profiles';
export * from './roles';
export * from './tenant';
