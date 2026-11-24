import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGcsLedger, createLocalLedger, type LedgerEntry } from '../erasure-ledger';
import { newId } from '../uuid';

// The erasure ledger: ids only, append-only, outside the database; damaged data is refused, never guessed.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lms-ledger-u-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  v: 1,
  requestId: newId(),
  tenantId: newId(),
  membershipId: newId(),
  userId: newId(),
  level: 'college',
  at: '2026-03-18T09:00:00.000Z',
  ...over,
});

describe('the local ledger', () => {
  it('appends one line per entry (JSON, ids and a time) and reads them back oldest first', async () => {
    const ledger = createLocalLedger({ dir: join(dir, 'a') });
    expect(await ledger.readAll()).toEqual([]); // no file yet
    const one = entry();
    const two = entry();
    await ledger.append(one);
    await ledger.append(two);
    expect(await ledger.readAll()).toEqual([one, two]);
    const text = await readFile(join(dir, 'a', 'erasure-ledger.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).not.toMatch(/@/); // nothing but ids and a time
    expect(Object.keys(JSON.parse(text.split('\n')[0] as string)).sort()).toEqual([
      'at',
      'level',
      'membershipId',
      'requestId',
      'tenantId',
      'userId',
      'v',
    ]);
  });

  it('the same request twice is one entry for the reader (a retry after a crash is harmless)', async () => {
    const ledger = createLocalLedger({ dir: join(dir, 'b') });
    const e = entry();
    await ledger.append(e);
    await ledger.append(e);
    expect(await ledger.readAll()).toEqual([e]);
  });

  it('refuses to write an entry that is not ids and a time, and refuses to read a damaged file instead of guessing', async () => {
    const ledger = createLocalLedger({ dir: join(dir, 'c') });
    await expect(ledger.append(entry({ userId: 'ada@example.com' }))).rejects.toThrow(
      /invalid ledger entry/,
    );
    // an extra field a caller adds (a name!) is never written: the line holds the seven known fields only
    await ledger.append({
      ...entry(),
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    } as LedgerEntry);
    const written = await readFile(join(dir, 'c', 'erasure-ledger.jsonl'), 'utf8');
    expect(written).not.toMatch(/Ada|@/);
    await appendFile(join(dir, 'c', 'erasure-ledger.jsonl'), 'not json\n');
    await expect(ledger.readAll()).rejects.toThrow(/refusing to guess/);
    await writeFile(join(dir, 'c', 'erasure-ledger.jsonl'), `${JSON.stringify({ v: 2 })}\n`);
    await expect(ledger.readAll()).rejects.toThrow(/refusing to guess/);
  });
});

describe('the GCS ledger is not built yet', () => {
  it('fails loudly (503), so an erasure waits instead of being forgotten', async () => {
    const ledger = createGcsLedger();
    await expect(ledger.append(entry())).rejects.toThrow(/not implemented/);
    await expect(ledger.readAll()).rejects.toThrow(/not implemented/);
  });
});
