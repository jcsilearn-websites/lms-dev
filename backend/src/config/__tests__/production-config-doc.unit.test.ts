import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiEnvSchema,
  assertAuthPolicy,
  assertPrivacyPolicy,
  assertSslPolicy,
  assertStoragePolicy,
  assertVideoPolicy,
  migrateEnvSchema,
  ownerEnvSchema,
  workerEnvSchema,
} from '../env';

// docs/production-config.md lists EVERY variable of the API, worker, migrate and owner-script schemas, with who uses it, whether it is required,
// its default and what production refuses. A variable added to a schema without a row in the doc fails here; a row for a variable that no
// schema has (renamed, removed) fails too; and the refusals the doc promises are checked against the real policy functions.

const doc = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'production-config.md'),
  'utf8',
).replaceAll('\r\n', '\n');
const start = doc.indexOf('## Environment variables and secrets');
const end = doc.indexOf('## Cloud SQL for PostgreSQL 17');
const section = doc.slice(start, end);

interface Row {
  name: string;
  usedBy: string;
  required: string;
  defaultValue: string;
  what: string;
  production: string;
}
const rows = new Map<string, Row>();
for (const line of section.split('\n')) {
  const m = /^\| `([A-Z][A-Z0-9_]+)`\s*\|/.exec(line);
  if (!m) continue;
  const cells = line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
  rows.set(m[1] as string, {
    name: m[1] as string,
    usedBy: cells[1] ?? '',
    required: cells[2] ?? '',
    defaultValue: cells[3] ?? '',
    what: cells[4] ?? '',
    production: cells[5] ?? '',
  });
}

const names = (schema: { properties: Record<string, unknown> }) => Object.keys(schema.properties);

describe('docs/production-config.md lists every environment variable', () => {
  it('has the section and a row for each documented variable', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(rows.size).toBeGreaterThan(100);
    for (const r of rows.values()) {
      expect(r.what.length, `${r.name}: what it is`).toBeGreaterThan(5);
      expect(r.required, `${r.name}: required / optional`).toMatch(/^(yes|no)/);
      expect(r.defaultValue, `${r.name}: default`).not.toBe('');
      expect(r.production, `${r.name}: what production refuses`).not.toBe('');
    }
  });

  it.each([
    ['API', apiEnvSchema, 'API'],
    ['worker', workerEnvSchema, 'worker'],
    ['migrate', migrateEnvSchema, 'migrate'],
    ['owner scripts', ownerEnvSchema, 'owner scripts'],
  ] as const)(
    'every variable of the %s schema has a row that names that process',
    (_label, schema, who) => {
      const missing = names(schema).filter((n) => !rows.has(n));
      expect(
        missing,
        `variables missing from docs/production-config.md: ${missing.join(', ')}`,
      ).toEqual([]);
      const wrongProcess = names(schema).filter((n) => !rows.get(n)?.usedBy.includes(who));
      expect(
        wrongProcess,
        `rows that do not say "${who}" uses them: ${wrongProcess.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('has no row for a variable that no schema has any more', () => {
    const all = new Set([
      ...names(apiEnvSchema),
      ...names(workerEnvSchema),
      ...names(migrateEnvSchema),
      ...names(ownerEnvSchema),
    ]);
    const stale = [...rows.keys()].filter((n) => !all.has(n));
    expect(stale, `rows of removed variables: ${stale.join(', ')}`).toEqual([]);
  });

  it('shows each default as the schema has it', () => {
    const check = (schema: { properties: Record<string, { default?: unknown }> }) => {
      for (const [name, p] of Object.entries(schema.properties)) {
        if (p.default === undefined || typeof p.default === 'object') continue;
        const shown = rows.get(name)?.defaultValue ?? '';
        const want = p.default === '' ? '`(empty)`' : `\`${String(p.default)}\``;
        expect(shown, `default of ${name}`).toBe(want);
      }
    };
    check(apiEnvSchema as never);
    check(workerEnvSchema as never);
    check(migrateEnvSchema as never);
  });
});

describe('the refusals the page promises are real', () => {
  const production = { NODE_ENV: 'production' };
  const says = (name: string, words: RegExp) =>
    expect(rows.get(name)?.production, `${name} row`).toMatch(words);

  it('DB_SSL off and no-verify, and any non-local host without verify-full', () => {
    says('DB_SSL', /verify-full/);
    expect(() =>
      assertSslPolicy({ ...production, DB_SSL: 'off' }, ['postgresql://x@localhost/db']),
    ).toThrow(/DB_SSL/);
    expect(() => assertSslPolicy({ ...production, DB_SSL: 'no-verify' })).toThrow(/DB_SSL/);
    expect(() => assertSslPolicy({ ...production, DB_SSL: 'verify-full' })).not.toThrow();
  });

  it('SUPPRESSION_HASH_KEYS is required in production, not elsewhere when STORAGE_SIGNING_SECRET exists', () => {
    says('SUPPRESSION_HASH_KEYS', /refuses to start/);
    expect(rows.get('SUPPRESSION_HASH_KEYS')?.required).toMatch(/^yes in production/);
    expect(() =>
      assertPrivacyPolicy({ ...production, STORAGE_SIGNING_SECRET: 's'.repeat(40) }),
    ).toThrow(/SUPPRESSION_HASH_KEYS: required/);
    expect(() =>
      assertPrivacyPolicy({ ...production, SUPPRESSION_HASH_KEYS: `k1:${'a'.repeat(40)}` }),
    ).not.toThrow();
    expect(() =>
      assertPrivacyPolicy({ NODE_ENV: 'development', STORAGE_SIGNING_SECRET: 's'.repeat(40) }),
    ).not.toThrow();
  });

  it('the local storage driver, the local video provider and the development e-mail providers are refused', () => {
    says('STORAGE_DRIVER', /`local` is refused/);
    says('VIDEO_PROVIDER', /`local` is refused/);
    says('EMAIL_PROVIDER', /console.*file.*none/);
    expect(() =>
      assertStoragePolicy({
        ...production,
        STORAGE_DRIVER: 'local',
        STORAGE_SIGNING_SECRET: 's'.repeat(40),
      }),
    ).toThrow(/STORAGE_DRIVER/);
    expect(() =>
      assertVideoPolicy({ ...production, VIDEO_PROVIDER: 'local', STORAGE_DRIVER: 'gcs' }),
    ).toThrow(/VIDEO_PROVIDER/);
    for (const provider of ['console', 'file', 'none']) {
      expect(() =>
        assertAuthPolicy(
          {
            ...production,
            MAILER: 'console',
            EMAIL_PROVIDER: provider,
            MAIL_FILE: 'x',
            EMAIL_FROM_DEFAULT: 'a@b.co',
            STORAGE_SIGNING_SECRET: 's'.repeat(40),
          },
          { APP_BASE_DOMAIN: 'example.org' },
        ),
      ).toThrow(/EMAIL_PROVIDER/);
    }
  });

  it('APP_BASE_DOMAIN, EMAIL_FROM_DEFAULT and SMTP_TLS=off are refused in production', () => {
    says('APP_BASE_DOMAIN', /set explicitly/);
    says('EMAIL_FROM_DEFAULT', /required/);
    says('SMTP_TLS', /`off` is refused/);
    const base = {
      ...production,
      MAILER: 'console',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.org',
      STORAGE_SIGNING_SECRET: 's'.repeat(40),
    };
    expect(() => assertAuthPolicy({ ...base, EMAIL_FROM_DEFAULT: 'a@b.co' }, {})).toThrow(
      /APP_BASE_DOMAIN/,
    );
    expect(() => assertAuthPolicy(base, { APP_BASE_DOMAIN: 'example.org' })).toThrow(
      /EMAIL_FROM_DEFAULT/,
    );
    expect(() =>
      assertAuthPolicy(
        { ...base, EMAIL_FROM_DEFAULT: 'a@b.co', SMTP_TLS: 'off' },
        { APP_BASE_DOMAIN: 'example.org' },
      ),
    ).toThrow(/SMTP_TLS/);
  });
});
