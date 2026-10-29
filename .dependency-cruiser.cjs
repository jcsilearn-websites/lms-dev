/** Layering rules for the modular backend + frontend/backend split (see docs/adr/0007). */

const MODULE = '^backend/src/modules/([^/]+)/';
const TESTS = '(__tests__/|^backend/test/|^backend/bench/)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular dependencies are not allowed.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'routes-only-controller-schemas-core',
      comment: 'routes may import only their controller, schemas and core.',
      severity: 'error',
      from: { path: `${MODULE}[^/]+.routes.ts$`, pathNot: TESTS },
      to: {
        path: '^backend/src/',
        pathNot: [`^backend/src/modules/$1/$1.(controller|schemas).ts$`, '^backend/src/core/'],
      },
    },
    {
      name: 'controller-no-repository-model-db',
      comment: 'controllers map requests to service calls: no repository, model or db access.',
      severity: 'error',
      from: { path: `${MODULE}[^/]+.controller.ts$`, pathNot: TESTS },
      to: {
        path: [
          '^backend/src/modules/[^/]+/[^/]+.(repository|model).ts$',
          '^backend/src/db/',
          '^(drizzle-orm|pg)(/|$)',
          '^node_modules/(drizzle-orm|pg)/',
        ],
      },
    },
    {
      name: 'repository-no-service-controller-routes',
      comment: 'repositories are SQL only: no upward dependencies.',
      severity: 'error',
      from: { path: `${MODULE}[^/]+.repository.ts$`, pathNot: TESTS },
      to: { path: '^backend/src/modules/[^/]+/[^/]+.(service|controller|routes).ts$' },
    },
    {
      name: 'modules-only-via-index',
      comment:
        'Other modules and the composition root may import a module only through its index.ts.',
      severity: 'error',
      from: { path: '^backend/src/', pathNot: [`${MODULE}`, TESTS] },
      to: { path: `${MODULE}`, pathNot: `${MODULE}index.ts$` },
    },
    {
      name: 'module-to-module-only-via-index',
      comment: "A module may import another module only through that module's index.ts.",
      severity: 'error',
      from: { path: `${MODULE}`, pathNot: TESTS },
      to: {
        path: '^backend/src/modules/([^/]+)/',
        pathNot: ['^backend/src/modules/$1/', '^backend/src/modules/[^/]+/index.ts$'],
      },
    },
    {
      name: 'core-is-a-leaf-layer',
      comment: 'core must not depend on modules or the database layer.',
      severity: 'error',
      from: { path: '^backend/src/core/', pathNot: TESTS },
      to: { path: ['^backend/src/modules/', '^backend/src/db/'] },
    },
    {
      name: 'db-no-modules',
      comment: 'the db layer must not depend on modules.',
      severity: 'error',
      from: { path: '^backend/src/db/', pathNot: TESTS },
      to: { path: '^backend/src/modules/' },
    },
    {
      name: 'contracts-are-self-contained',
      comment: 'contracts are shared with the frontend: they may not import other backend code.',
      severity: 'error',
      from: { path: '^backend/src/contracts/' },
      to: { path: '^backend/', pathNot: '^backend/src/contracts/' },
    },
    {
      name: 'backend-no-frontend',
      comment: 'nothing in backend imports from frontend.',
      severity: 'error',
      from: { path: '^backend/' },
      to: { path: ['^frontend/', '^node_modules/@lms/frontend/'] },
    },
    {
      name: 'frontend-only-backend-contracts',
      comment: 'frontend may import backend only via "@lms/backend/contracts".',
      severity: 'error',
      from: { path: '^frontend/' },
      to: { path: '^backend/', pathNot: '^backend/src/contracts/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    exclude: { path: ['/dist/', '.d.ts$'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
