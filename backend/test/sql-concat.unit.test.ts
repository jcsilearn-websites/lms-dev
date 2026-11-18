// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are code samples for the scanner, ${} is the point
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import allowlist from './sql-concat.allowlist.json';
import { type Finding, scanSource } from './sql-scan';

// Step 14a: no SQL is built by string construction from user input. See test/sql-scan.ts for what is flagged. Every finding is
// on test/sql-concat.allowlist.json with the reason it is safe; a NEW one fails here until a reviewer adds it (with a reason), and a
// reason that no longer matches any code fails too (the list stays tight).

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

interface Entry {
  file: string;
  kind: string;
  text: string;
  reason: string;
}
const entries = allowlist as Entry[];
const keyOf = (f: { file: string; kind: string; text: string }) => `${f.file}|${f.kind}|${f.text}`;

describe('detector (it must catch what it is for)', () => {
  const scan = (src: string) => scanSource('x.ts', src);
  it('flags raw SQL from an expression, built query strings, untagged SQL templates and concatenation', () => {
    expect(scan('const q = sql.raw(req.query.order);').map((f) => f.kind)).toEqual([
      'sql-raw-dynamic',
    ]);
    expect(
      scan("await client.query(`SELECT * FROM lms.users WHERE email = '${email}'`);").map(
        (f) => f.kind,
      ),
    ).toEqual(['query-dynamic-string']);
    expect(
      scan("await db.execute('DELETE FROM lms.users WHERE id = ' + id);").map((f) => f.kind),
    ).toEqual(['query-dynamic-string', 'sql-string-concat']);
    expect(scan('const q = `UPDATE lms.t SET a = ${v}`;').map((f) => f.kind)).toEqual([
      'untagged-sql-template',
    ]);
    expect(scan("const q = 'SELECT * FROM t WHERE a = ' + v;").map((f) => f.kind)).toEqual([
      'sql-string-concat',
    ]);
  });
  it('passes what is safe: bind parameters, tagged templates, static strings', () => {
    expect(scan("await client.query('SELECT 1 WHERE id = $1', [id]);")).toEqual([]);
    expect(scan('const q = sql`SELECT * FROM lms.users WHERE email = ${email}`;')).toEqual([]);
    expect(scan("const q = sql.raw('lms.users');")).toEqual([]);
    expect(scan('const msg = `Hello ${name}, you selected ${n} items`;')).toEqual([]);
  });
});

describe('the code', () => {
  const found: Finding[] = [];
  for (const f of files(SRC)) found.push(...scanSource(rel(f), readFileSync(f, 'utf8')));

  it('has no SQL built by string construction that a reviewer has not read', () => {
    const allowed = new Set(entries.map(keyOf));
    const unreviewed = found.filter((f) => !allowed.has(keyOf(f)));
    expect(
      unreviewed.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text}`),
      'add each to test/sql-concat.allowlist.json WITH the reason it is safe (what constrains the text), or fix it',
    ).toEqual([]);
  });

  it('keeps the allowlist tight: every entry still matches code, and says why it is safe', () => {
    const present = new Set(found.map(keyOf));
    expect(entries.filter((e) => !present.has(keyOf(e))).map((e) => `${e.file} ${e.text}`)).toEqual(
      [],
    );
    expect(entries.filter((e) => e.reason.trim().length < 25).map((e) => e.file)).toEqual([]);
  });
});
