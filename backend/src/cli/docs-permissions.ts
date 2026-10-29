import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app';
import { apiEnvSchema, parseEnv } from '../config/env';
import { createLogger } from '../config/logger';
import { type DocRoute, type RouteDeclaration, renderPermissionsDoc } from '../core/authz';
import type { Database } from '../db/client';

// Generates docs/permissions.md from the code:   pnpm docs:permissions
// Check mode (CI):                                pnpm docs:permissions --check
// It boots the app with a stub database (nothing connects) just to list the registered routes.

export const PERMISSIONS_DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/permissions.md',
);

/** Every registered API route with its authorization declaration. */
export async function collectRoutes(): Promise<DocRoute[]> {
  const env = parseEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_APP_URL: 'postgresql://lms_app:x@localhost:5432/lms',
    DB_SSL: 'off',
  });
  const db = new Proxy({} as Database, {
    get: () => () => {
      throw new Error('the docs generator must not touch the database');
    },
  });
  const app = buildApp({ env, db, logger: createLogger(env) });
  const routes: DocRoute[] = [];
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/docs') || route.schema?.hide === true) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue; // derived from GET, same declaration
      routes.push({
        method: String(method),
        url: route.url,
        config: route.config as RouteDeclaration | undefined,
      });
    }
  });
  await app.ready();
  await app.close();
  return routes;
}

export async function generatePermissionsDoc(): Promise<string> {
  return renderPermissionsDoc(await collectRoutes());
}

async function main(): Promise<void> {
  const content = await generatePermissionsDoc();
  if (process.argv.includes('--check')) {
    const current = readFileSync(PERMISSIONS_DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
    if (current !== content) {
      console.error(
        'docs/permissions.md is out of date: run `pnpm docs:permissions` and commit it',
      );
      process.exit(1);
    }
    console.log('docs/permissions.md is up to date');
    return;
  }
  writeFileSync(PERMISSIONS_DOC_PATH, content, 'utf8');
  console.log(`wrote ${PERMISSIONS_DOC_PATH}`);
}

const entry = process.argv[1] ?? '';
if (/docs-permissions\.[cm]?[jt]s$/.test(entry)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'failed');
    process.exit(1);
  });
}
