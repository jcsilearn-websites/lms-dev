#!/usr/bin/env node
// Bundle budget check (CI and local): fails when a page loads more JavaScript than allowed.
//
//   login page, initial load   <= 125 KB gzip   every chunk the entry reaches by STATIC imports
//   any route                  <= 150 KB gzip   the route chunk plus the static chunks it needs
//                                               that the login page has not already loaded
//   any single chunk file      <= 150 KB gzip
//
// The graph comes from Vite's manifest (dist/.vite/manifest.json): `imports` are static (loaded
// before the page runs), `dynamicImports` are lazy (loaded on demand: route chunks and the form
// validation chunk). The login number is reported twice: the initial load and "after the first
// form interaction" (initial + the lazily loaded validation chunk).
//
// Usage: node scripts/check-bundle-size.mjs [--json] (run `pnpm build` first)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = join(import.meta.dirname, '..', 'dist');
const LOGIN_BUDGET_KB = Number(process.env.LOGIN_BUDGET_KB ?? 125);
const ROUTE_BUDGET_KB = Number(process.env.ROUTE_BUDGET_KB ?? 150);
const json = process.argv.includes('--json');

const manifestPath = join(DIST, '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('dist/.vite/manifest.json not found: run "pnpm build" first');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const gzCache = new Map();
const gz = (file) => {
  if (!gzCache.has(file)) {
    gzCache.set(file, gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length);
  }
  return gzCache.get(file);
};
const kb = (bytes) => bytes / 1024;

/** All chunk keys reachable from `key` through static imports (including `key`). */
function staticGraph(key, seen = new Set()) {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const dep of manifest[key]?.imports ?? []) staticGraph(dep, seen);
  return seen;
}
const filesOf = (keys) => [...keys].map((k) => manifest[k].file).filter((f) => f.endsWith('.js'));
const total = (files) => files.reduce((sum, f) => sum + gz(f), 0);

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
if (!entryKey) throw new Error('no entry chunk in the manifest');

// ---- login page: the entry and everything it imports statically
const loginKeys = staticGraph(entryKey);
const loginFiles = filesOf(loginKeys);
const loginBytes = total(loginFiles);

// ---- lazy chunks: routes and the validation chunk
const lazyKeys = new Set();
for (const k of loginKeys) for (const d of manifest[k].dynamicImports ?? []) lazyKeys.add(d);
const results = [];
for (const key of lazyKeys) {
  const own = staticGraph(key);
  const needed = filesOf(own).filter((f) => !loginFiles.includes(f));
  results.push({ key, name: key.replace(/^src\//, ''), files: needed, bytes: total(needed) });
}
results.sort((a, b) => b.bytes - a.bytes);

const validation = results.find((r) => /auth\.validators/.test(r.key));
const loginAfterInteraction = loginBytes + (validation?.bytes ?? 0);

const failures = [];
if (kb(loginBytes) > LOGIN_BUDGET_KB) {
  failures.push(`login page initial load ${kb(loginBytes).toFixed(1)} KB > ${LOGIN_BUDGET_KB} KB`);
}
for (const r of results) {
  if (kb(r.bytes) > ROUTE_BUDGET_KB) {
    failures.push(`route chunk ${r.name} ${kb(r.bytes).toFixed(1)} KB > ${ROUTE_BUDGET_KB} KB`);
  }
}
const allJs = Object.values(manifest)
  .map((m) => m.file)
  .filter((f) => f.endsWith('.js'));
for (const f of new Set(allJs)) {
  if (kb(gz(f)) > ROUTE_BUDGET_KB)
    failures.push(`chunk ${f} ${kb(gz(f)).toFixed(1)} KB > ${ROUTE_BUDGET_KB} KB`);
}

const report = {
  loginInitialKb: Number(kb(loginBytes).toFixed(1)),
  loginAfterFirstInteractionKb: Number(kb(loginAfterInteraction).toFixed(1)),
  loginBudgetKb: LOGIN_BUDGET_KB,
  routeBudgetKb: ROUTE_BUDGET_KB,
  loginChunks: loginFiles.map((f) => ({ file: f, kb: Number(kb(gz(f)).toFixed(1)) })),
  routes: results.map((r) => ({ name: r.name, kb: Number(kb(r.bytes).toFixed(1)) })),
  failures,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Login page, initial load:            ${report.loginInitialKb} KB gzip (budget ${LOGIN_BUDGET_KB})`,
  );
  for (const c of report.loginChunks) console.log(`    ${c.file.padEnd(48)} ${c.kb} KB`);
  console.log(
    `Login page after first interaction:  ${report.loginAfterFirstInteractionKb} KB gzip (validation chunk loaded)`,
  );
  console.log(
    `Lazy chunks (extra JS a route loads on top of the login page), budget ${ROUTE_BUDGET_KB} KB:`,
  );
  for (const r of report.routes) console.log(`    ${r.name.padEnd(52)} ${r.kb} KB`);
}
if (failures.length > 0) {
  console.error(`\nBUNDLE BUDGET EXCEEDED:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
if (!json) console.log('\nBundle budgets OK');
