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

describe('docs/data-retention.md: the account level', () => {
  const doc = read('docs/data-retention.md');

  it('says who may ask, what it does, what stays, and that the academic record is untouched', () => {
    expect(doc).toContain('no membership that is not removed');
    expect(doc).toContain('Former user');
    expect(doc).toMatch(/never touches a college's academic record/);
    expect(doc).toMatch(/What stays after an account erasure, and for how long/);
    expect(doc).toMatch(/a \*\*different\*\* platform administrator/);
    expect(doc).toContain('**7 days of grace**');
    expect(doc).toContain('**30 days**');
    expect(doc).toMatch(/only the keyed hash stays/);
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

  it('says where the erasure ledger lives and what losing the hash keys means', () => {
    expect(doc).toMatch(/separate from the database backups/);
    expect(doc).toMatch(/object versioning ON/);
    expect(doc).toMatch(/retention lock/);
    expect(doc).toMatch(/write-only/);
    expect(doc).toMatch(/must be backed up/);
    expect(doc).toMatch(/If a key is lost/);
    expect(doc).toMatch(/cannot be repaired/);
  });

  it('CLAUDE.md carries the same two warnings in its GCP list', () => {
    const guide = read('CLAUDE.md');
    expect(guide).toMatch(/erasure ledger bucket[^\n]*separate from the database backups/);
    expect(guide).toMatch(/SUPPRESSION_HASH_KEYS[^\n]*backed up/);
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
