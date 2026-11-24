import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERASURE_RULES } from '../src/contracts';

// The documents the screens and e-mails are worded from must agree with the code: the numbers (30 days, 7 days, backups, archives), the
// words about the academic record and the frozen gradebooks, and the variables an operator has to set.

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

describe('docs/data-retention.md', () => {
  const doc = read('docs/data-retention.md');

  it('states the rules of the code', () => {
    expect(doc).toContain(`**${ERASURE_RULES.requestExpiresAfterDays} days**`);
    expect(doc).toContain(`**${ERASURE_RULES.graceDays} days of grace**`);
    expect(doc).toContain(`**${ERASURE_RULES.exportRetentionDays} days**`);
    expect(doc).toContain(`logical dumps **${ERASURE_RULES.backupRetentionDays} days**`);
  });

  it('says plainly that approved gradebooks keep the name and register number, and flags it for counsel', () => {
    expect(doc).toMatch(/keeps the name and register number it recorded/);
    expect(doc).toContain('COUNSEL');
    expect(doc).toMatch(/Audit trail/);
    expect(doc).toMatch(/Backups/);
    expect(doc).toMatch(/pnpm privacy:reapply-erasures/);
  });
});

describe('docs/production-config.md', () => {
  const doc = read('docs/production-config.md');

  it('documents every variable of the data protection step, the rotation and the restore', () => {
    for (const v of [
      'SUPPRESSION_HASH_KEYS',
      'ERASURE_LEDGER_DIR',
      'PRIVACY_ERASURE_SCAN_SECONDS',
      'DATA_EXPORT_RATE_PER_HOUR',
    ])
      expect(doc, v).toContain(v);
    expect(doc).toContain('privacy_suppression_key_usage');
    expect(doc).toContain('pnpm privacy:reapply-erasures --yes');
    expect(doc).toMatch(/Secret Manager/);
  });

  it('every one of those variables is in .env.example', () => {
    const example = read('.env.example');
    for (const v of [
      'SUPPRESSION_HASH_KEYS',
      'ERASURE_LEDGER_DIR',
      'PRIVACY_ERASURE_SCAN_SECONDS',
      'DATA_EXPORT_RATE_PER_HOUR',
    ])
      expect(example, v).toContain(v);
  });
});
