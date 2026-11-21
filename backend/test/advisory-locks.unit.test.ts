import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Every advisory lock the application takes is TRANSACTION-scoped (`pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`): it is released
// by COMMIT / ROLLBACK, so a crash, a timeout or a pooled connection returned early can never leave a lock behind on a connection that
// the pool hands to the next request. A SESSION-scoped lock (`pg_advisory_lock`, `pg_try_advisory_lock`, the `_shared` variants,
// `pg_advisory_unlock*`) survives the transaction and stays on a pooled connection until someone unlocks it.
//
// This test fails on any such call in code, SQL migrations or scripts. The allowlist holds a call that is session-scoped ON PURPOSE,
// with the reason; a new entry needs a reviewer to agree with the reason.

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCAN = [
  'backend/src',
  'backend/migrations',
  'backend/test',
  'backend/bench',
  'scripts',
  'frontend/scripts',
];
const THIS = 'backend/test/advisory-locks.unit.test.ts';

const ALLOWED: Record<string, string> = {
  'backend/src/db/migrate.ts':
    'the migration runner holds ONE lock across one transaction per migration file, on a DEDICATED client (never the pool), and unlocks it in `finally`; ' +
    'a transaction-scoped lock would be released after the first file. Not reachable from a request.',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|sql|mjs|js|cjs|sh)$/.test(p)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

/** the text without comments: a comment may name a function to explain why it is not used */
function strip(text: string, file: string): string {
  if (file.endsWith('.sql')) return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// pg_advisory_lock, pg_advisory_lock_shared, pg_try_advisory_lock(_shared), pg_advisory_unlock(_shared|_all): everything advisory that is
// NOT `_xact_`. (`pg_advisory_xact_lock` has `xact` between `advisory` and `lock`, so it does not match.)
const SESSION_LOCK = /\bpg_(?:try_)?advisory_(?:lock|unlock)\w*/gi;

describe('advisory locks are transaction-scoped (static guard)', () => {
  it('the pattern catches the session-scoped functions and not the transaction-scoped ones', () => {
    const hits = (s: string) => s.match(SESSION_LOCK) ?? [];
    for (const bad of [
      'pg_advisory_lock',
      'pg_advisory_lock_shared',
      'pg_try_advisory_lock',
      'pg_try_advisory_lock_shared',
      'pg_advisory_unlock',
      'pg_advisory_unlock_all',
      'PG_ADVISORY_LOCK(1)',
    ]) {
      expect(hits(`SELECT ${bad}`), bad).toHaveLength(1);
    }
    for (const good of [
      'pg_advisory_xact_lock',
      'pg_advisory_xact_lock_shared',
      'pg_try_advisory_xact_lock',
      'pg_try_advisory_xact_lock_shared',
    ]) {
      expect(hits(`SELECT ${good}`), good).toHaveLength(0);
    }
  });

  it('no file calls a session-scoped advisory lock, except the allowlisted ones', () => {
    const found: Record<string, string[]> = {};
    let scanned = 0;
    for (const dir of SCAN) {
      for (const file of walk(path.join(ROOT, dir))) {
        const r = rel(file);
        if (r === THIS) continue;
        scanned++;
        const hits = strip(readFileSync(file, 'utf8'), r).match(SESSION_LOCK);
        if (hits) found[r] = hits;
      }
    }
    expect(scanned).toBeGreaterThan(200); // the scan really walked the tree
    const offenders = Object.keys(found).filter((f) => !(f in ALLOWED));
    expect(
      offenders.map((f) => `${f}: ${found[f]?.join(', ')}`),
      'use pg_advisory_xact_lock / pg_try_advisory_xact_lock (released by COMMIT or ROLLBACK)',
    ).toEqual([]);
  });

  it('every allowlisted file still contains the call (a stale entry is removed) and has a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, file).toBeGreaterThan(40);
      const hits = strip(readFileSync(path.join(ROOT, file), 'utf8'), file).match(SESSION_LOCK);
      expect(
        hits,
        `${file} no longer takes a session lock: delete its allowlist entry`,
      ).not.toBeNull();
    }
  });

  it('the application code takes advisory locks only as transaction-scoped calls (positive check)', () => {
    const xact = /\bpg_(?:try_)?advisory_xact_lock\w*/g;
    const where = ['backend/src', 'backend/migrations']
      .flatMap((d) => walk(path.join(ROOT, d)))
      .filter((f) => strip(readFileSync(f, 'utf8'), f).match(xact))
      .map(rel);
    // core/locks.ts names the keys; the repositories and the definer functions take them
    expect(where).toEqual(
      expect.arrayContaining([
        'backend/src/modules/analytics/analytics.repository.ts',
        'backend/src/modules/notifications/notifications.repository.ts',
        'backend/migrations/0008_member_management.sql',
        'backend/migrations/0059_audit_atomic_and_races.sql',
      ]),
    );
  });
});
