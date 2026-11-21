import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Data protection (step 14b-1): inside a college, a member's name and address are read through lms.member_identity (migration 0060),
// the one place that knows about the erasure override. A repository or service that reads lms.users directly would show the real
// name of an erased member, so every direct reader of the table is listed here WITH the reason it needs the real value.
// The database functions have the same list in test/identity-readers.test.ts (it reads the catalog).
//
// To add a reader: use lms.member_identity (alias it `u`; it has tenant_id, membership_id, user_id, display_name, email, erased).
// Add a file to the list only when it truly needs the GLOBAL account (sign-in, the person's own account, mail delivery, tooling).

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'backend/src');

const ALLOWED: Record<string, string> = {
  'backend/src/modules/auth/auth.repository.ts':
    'invite acceptance and password reset: the address the token was issued to, read by the person who holds the token (sign-in flows)',
  'backend/src/modules/imports/imports.repository.ts':
    'matches the staged addresses against existing accounts and creates accounts; it never shows a name (an import never touches a removed member)',
  'backend/src/db/seed.ts': 'development seed data (refuses production)',
  'backend/src/cli/create-platform-admin.ts': 'bootstrap of the first platform administrator',
  'backend/src/db/dev-cleanup.ts': 'development database hygiene (refuses production)',
};
// the users module itself owns the global account (the signed-in person reads and creates THEIR OWN row)
const ALLOWED_PREFIX = ['backend/src/modules/users/'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walk(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// the table name in SQL, and the Drizzle model of it
const SQL_READ = /\blms\.users\b/;
const MODEL_IMPORT = /users\.model'/;

describe('who reads lms.users directly (static guard)', () => {
  it('no repository, service or controller reads the global user table, except the listed ones', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walk(SRC)) {
      const r = rel(file);
      scanned++;
      if (r in ALLOWED || ALLOWED_PREFIX.some((p) => r.startsWith(p))) continue;
      const text = strip(readFileSync(file, 'utf8'));
      if (SQL_READ.test(text)) offenders.push(`${r}: reads lms.users`);
      if (MODEL_IMPORT.test(text)) offenders.push(`${r}: imports the users model`);
    }
    expect(scanned).toBeGreaterThan(200);
    expect(
      offenders,
      'read a member through lms.member_identity (it applies the erasure override); a new direct reader needs a reason in this file',
    ).toEqual([]);
  });

  it('every listed file still reads the table and has a real reason (a stale entry is removed)', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, file).toBeGreaterThan(30);
      expect(
        SQL_READ.test(strip(readFileSync(path.join(ROOT, file), 'utf8'))),
        `${file} no longer reads lms.users: delete its entry`,
      ).toBe(true);
    }
  });

  it('the guard sees a direct read (positive control)', () => {
    expect(SQL_READ.test('SELECT u.display_name FROM lms.users u')).toBe(true);
    expect(SQL_READ.test('SELECT u.display_name FROM lms.member_identity u')).toBe(false);
  });

  it('the readers of a name that were moved to the view read it (the sweep: each file uses lms.member_identity)', () => {
    for (const f of [
      'analytics/analytics.repository.ts',
      'assessments/assessments.repository.ts',
      'assignments/assignments.repository.ts',
      'audit/audit.repository.ts',
      'courses/courses.repository.ts',
      'memberships/memberships.repository.ts',
      'progress/progress.repository.ts',
      'questions/questions.repository.ts',
    ]) {
      expect(readFileSync(path.join(SRC, 'modules', f), 'utf8'), f).toContain(
        'lms.member_identity',
      );
    }
  });
});
