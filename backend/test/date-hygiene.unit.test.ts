import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { monthInZone } from './dates';

// A cheap guard (no database) for the bug class behind three CI failures at 00:08 IST: a test, or product code, that takes a day from
// the WRONG clock. The product's day is the college-local day (lms.local_day); the CI session zone is UTC; between 18:30 and 24:00 UTC
// the two dates differ. Rules and the reasoning: CLAUDE.md "Time-dependent tests". A line that is right for a stated reason carries
// `// date-ok: <why>`.

const BACKEND = fileURLToPath(new URL('..', import.meta.url));

interface Rule {
  id: string;
  why: string;
  test: RegExp;
  /** a line that also matches this is fine (it already names the college zone) */
  unless?: RegExp;
}

/** Local-time getters and setters of the machine running the code: they depend on the TZ environment variable. */
const LOCAL_CLOCK: Rule = {
  id: 'local-clock',
  why: 'depends on the TZ of the machine; use the getUTC* family or Intl with an explicit timeZone',
  test: /\.(getDate|getDay|getHours|getMinutes|getMonth|getFullYear)\(\)|\.set(Hours|Date|Month|FullYear)\(|toLocale(Date|Time)?String/,
};
const CURRENT_DATE: Rule = {
  id: 'current_date',
  why: "is the database session's date; write a day with lms.local_day(now(), '<college zone>')",
  test: /\bcurrent_date\b/i,
};
/** Rules for test files. */
const TEST_RULES: Rule[] = [
  LOCAL_CLOCK,
  CURRENT_DATE,
  {
    id: 'now-cast-to-date',
    why: "now()::date is the session's date; use lms.local_day(now(), '<college zone>') - N",
    test: /now\(\)[^;\n]*::date|::date[^;\n]*now\(\)/,
    unless: /local_day|AT TIME ZONE/i,
  },
  {
    id: 'iso-date-slice',
    why: 'toISOString().slice() is the UTC date or month; use dates.ts monthInZone or lms.local_day',
    test: /toISOString\(\)\s*\.\s*(slice|substring|split)/,
  },
];
/** Rules for product code (a UTC round trip of a YYYY-MM-DD string is legitimate there, so only the machine-clock ones). */
const PRODUCT_RULES: Rule[] = [LOCAL_CLOCK, CURRENT_DATE];

function violations(source: string, rules: Rule[]): { line: number; rule: Rule; text: string }[] {
  const out: { line: number; rule: Rule; text: string }[] = [];
  source.split('\n').forEach((text, i) => {
    if (text.includes('date-ok')) return;
    for (const rule of rules)
      if (rule.test.test(text) && !rule.unless?.test(text))
        out.push({ line: i + 1, rule, text: text.trim() });
  });
  return out;
}

function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.split(sep).includes('node_modules'))
    .map((f) => join(dir, f));
}

const isTest = (path: string) => /(\.test\.ts$|[\\/]__tests__[\\/]|[\\/]test[\\/])/.test(path);
const SELF = join(BACKEND, 'test', 'date-hygiene.unit.test.ts');

describe('date hygiene (the college-local day, never the session or UTC date)', () => {
  it('no test takes a day from the wrong clock', () => {
    const found: string[] = [];
    for (const f of [
      ...filesUnder(join(BACKEND, 'test')),
      ...filesUnder(join(BACKEND, 'src')),
    ].filter(isTest)) {
      if (f === SELF) continue;
      for (const v of violations(readFileSync(f, 'utf8'), TEST_RULES))
        found.push(
          `${relative(BACKEND, f)}:${v.line} [${v.rule.id}] ${v.rule.why}\n      ${v.text}`,
        );
    }
    expect(
      found,
      `Use lms.local_day / dates.ts, or mark a justified line with // date-ok: <why>\n${found.join('\n')}`,
    ).toEqual([]);
  });

  it('no product code depends on the time zone of the machine', () => {
    const found: string[] = [];
    for (const f of filesUnder(join(BACKEND, 'src')).filter((p) => !isTest(p))) {
      for (const v of violations(readFileSync(f, 'utf8'), PRODUCT_RULES))
        found.push(
          `${relative(BACKEND, f)}:${v.line} [${v.rule.id}] ${v.rule.why}\n      ${v.text}`,
        );
    }
    expect(found, found.join('\n')).toEqual([]);
  });

  it('the guard itself flags what it should and accepts what is marked', () => {
    const bad = [
      'const month = new Date().toISOString().slice(0, 7);',
      "INSERT ... VALUES ((now() - ($1 || ' days')::interval)::date)",
      'WHERE day = current_date',
      'const d = new Date().getDate();',
      'x.toLocaleDateString()',
    ];
    for (const line of bad) expect(violations(line, TEST_RULES), line).not.toEqual([]);
    const fine = [
      "lms.local_day(now(), 'Asia/Kolkata') - 1",
      "(now() AT TIME ZONE 'Asia/Kolkata')::date",
      'const d = new Date().getUTCDate();',
      'const x = d.toISOString().slice(0, 10); // date-ok: wide margin',
    ];
    for (const line of fine) expect(violations(line, TEST_RULES), line).toEqual([]);
  });

  it('monthInZone: the college month changes at 18:30 UTC of the last day (month end, year end, leap day)', () => {
    expect(monthInZone(new Date('2026-11-30T18:29:00Z'))).toBe('2026-11');
    expect(monthInZone(new Date('2026-11-30T18:31:00Z'))).toBe('2026-12');
    expect(monthInZone(new Date('2026-12-31T18:29:00Z'))).toBe('2026-12');
    expect(monthInZone(new Date('2026-12-31T18:31:00Z'))).toBe('2027-01');
    expect(monthInZone(new Date('2028-02-29T18:29:00Z'))).toBe('2028-02');
    expect(monthInZone(new Date('2028-02-29T18:31:00Z'))).toBe('2028-03');
    // the UTC month would have been wrong during those hours
    expect(new Date('2026-11-30T18:31:00Z').toISOString().slice(0, 7)).toBe('2026-11'); // date-ok: shows the bug being avoided
  });
});
