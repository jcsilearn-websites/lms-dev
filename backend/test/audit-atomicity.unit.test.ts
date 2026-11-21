import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuditService } from '../src/modules/audit/audit.service';
import { fakeDb } from './fakes';

// CLASS A guard (CI found it twice): a state change and its audit row must be ONE transaction. The root cause was an API that made the
// wrong thing easy: `auditService.record(...)` opened its OWN transaction, so any service could write "change; then audit". It is gone.
// What is left:
//   1. a service can write an audit row only INSIDE a transaction it already holds (`recordIn`), or through a fused statement /
//      definer function that carries its own audit insert (the `auditId` / `auditInsertFrom` pattern);
//   2. this test fails when someone brings the pattern back: an audit call that opens its own transaction, or raw SQL that writes an
//      audit table outside the places that are known to do it in the SAME statement as the change.
// The behaviour is pinned by `audit-atomicity.test.ts` (failure injection: the audit insert raises, the change must not survive).

const SRC = path.resolve(import.meta.dirname, '../src');
const skip = (p: string) => /__tests__|\.test\.ts$|node_modules/.test(p);
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');
/** the code of a file without comments (a comment may name what it explains) */
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const all = files(SRC);

describe('audit atomicity (static guard)', () => {
  it('the audit service has no method that writes in a transaction of its own', () => {
    const service = createAuditService({
      db: fakeDb(),
      auditRepo: {} as never,
    });
    // `recordIn` takes the caller's transaction; `withPlatformAdminAccess` writes in the transaction of the access it wraps.
    expect(Object.keys(service).sort()).toEqual([
      'listPlatformLog',
      'listTenantLog',
      'recordIn',
      'withPlatformAdminAccess',
    ]);
  });

  it('no code calls an audit method that does not exist any more (record / recordPlatform)', () => {
    const offenders = all
      .filter((p) => /\baudit\w*\s*\.\s*(record|recordPlatform)\s*\(/i.test(code(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('only the audit module touches the audit repository', () => {
    const offenders = all
      .filter((p) => !rel(p).startsWith('modules/audit/'))
      .filter((p) => /\bauditRepo\s*\.\s*insert(Platform)?\s*\(/.test(code(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  // Raw SQL that INSERTs into an audit table. Each place is on this list WITH the reason its audit row is in the same statement
  // (or the same transaction) as the change it records. A new one fails until a reviewer adds it here with a reason.
  const RAW_AUDIT_INSERTS: Record<string, string> = {
    'modules/audit/audit.sql.ts':
      'auditInsertFrom: the CTE every repository folds INTO its change statement (one statement, one commit)',
    'modules/audit/audit.repository.ts':
      'the repository behind recordIn / withPlatformAdminAccess (caller transaction)',
    'modules/analytics/analytics.repository.ts':
      'setSettings: the data-modifying CTE of the settings write includes its audit insert (one statement)',
    'db/dev-cleanup.ts': 'DELETEs for the dev database cleanup, not an audit write',
  };

  it('raw SQL that writes an audit table is only where its row shares the statement with the change', () => {
    const found = all
      .filter((p) => /insert\s+into\s+lms\.(platform_)?audit_log/i.test(code(p)))
      .map(rel)
      .sort();
    const unexpected = found.filter((f) => !(f in RAW_AUDIT_INSERTS));
    expect(unexpected).toEqual([]);
  });

  it('every entry of the list above still exists (the list stays tight)', () => {
    const present = new Set(all.map(rel));
    const dead = Object.keys(RAW_AUDIT_INSERTS).filter((f) => !present.has(f));
    expect(dead).toEqual([]);
  });
});
