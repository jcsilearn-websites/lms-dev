import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageUnavailableError } from './storage';

// The ERASURE LEDGER (step 14b, data protection): an append-only record of who was erased, kept OUTSIDE the database, so that a
// restore of an OLDER backup cannot bring an erased person back: `pnpm privacy:reapply-erasures` reads the ledger and erases them
// again. It holds IDS ONLY (request, membership, user, college, level, time): no name, no address, nothing about the person.
//
// The local driver is a JSON-lines file next to the application (development and CI). In production the ledger must live where a
// database restore does not reach and nobody can rewrite it: the GCS driver (a bucket with a retention lock) is built in the GCP step;
// until then it answers like the other GCS stubs (503), and an erasure waits instead of being forgotten.

export interface CollegeLedgerEntry {
  v: 1;
  requestId: string;
  tenantId: string;
  membershipId: string;
  userId: string;
  level: 'college';
  /** when the erasure was executed (ISO) */
  at: string;
}
/** The global account (no college, no membership: the person is erased everywhere they were). */
export interface AccountLedgerEntry {
  v: 1;
  requestId: string;
  userId: string;
  level: 'account';
  at: string;
}
export type LedgerEntry = CollegeLedgerEntry | AccountLedgerEntry;

export interface ErasureLedger {
  readonly driver: 'local' | 'gcs';
  /** Appends one entry durably (flushed to disk). Appending the same request twice is harmless: readers de-duplicate. */
  append(entry: LedgerEntry): Promise<void>;
  /** Every entry, oldest first, one per request. */
  readAll(): Promise<LedgerEntry[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ids = (x: Record<string, unknown>, keys: string[]) =>
  keys.every((k) => typeof x[k] === 'string' && UUID.test(x[k] as string));
const valid = (e: unknown): e is LedgerEntry => {
  const x = e as Record<string, unknown> | null;
  if (x?.v !== 1 || typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return false;
  if (x.level === 'college') return ids(x, ['requestId', 'tenantId', 'membershipId', 'userId']);
  if (x.level === 'account') return ids(x, ['requestId', 'userId']);
  return false;
};
/** ONLY the known fields of the level are written, whatever the caller passes: the ledger can never hold a name or an address */
const project = (e: LedgerEntry): LedgerEntry =>
  e.level === 'college'
    ? {
        v: 1,
        requestId: e.requestId,
        tenantId: e.tenantId,
        membershipId: e.membershipId,
        userId: e.userId,
        level: 'college',
        at: e.at,
      }
    : { v: 1, requestId: e.requestId, userId: e.userId, level: 'account', at: e.at };

/**
 * A crash in the middle of an earlier append leaves a last line without its newline. That fragment was never acknowledged (the database
 * still has the entry pending), so it is cut off before the next entry is written: the file never holds a damaged line in the middle.
 */
async function dropTornTail(file: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(file, 'r+');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return;
    const bytes = await fh.readFile();
    if (bytes[bytes.length - 1] === 0x0a) return;
    await fh.truncate(bytes.lastIndexOf(0x0a) + 1);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export function createLocalLedger(opts: { dir: string }): ErasureLedger {
  const file = path.resolve(opts.dir, 'erasure-ledger.jsonl');
  return {
    driver: 'local',
    async append(entry) {
      if (!valid(entry)) throw new Error('invalid ledger entry');
      await mkdir(path.dirname(file), { recursive: true });
      const clean = project(entry);
      await dropTornTail(file);
      await appendFile(file, `${JSON.stringify(clean)}\n`, { flag: 'a' });
      // flushed to disk before the database is told the entry exists
      const fh = await open(file, 'a');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    async readAll() {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return [];
        throw err;
      }
      const seen = new Set<string>();
      const out: LedgerEntry[] = [];
      const lines = text.split('\n');
      // the LAST line without a newline is a torn write (the process died while appending): it was never acknowledged, so it is
      // ignored; the entry is still pending in the database and the next scan appends it again
      const torn = !text.endsWith('\n');
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue;
        if (torn && i === lines.length - 1) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error('the erasure ledger has a line that is not JSON: refusing to guess');
        }
        if (!valid(parsed))
          throw new Error('the erasure ledger has an invalid entry: refusing to guess');
        if (seen.has(parsed.requestId)) continue;
        seen.add(parsed.requestId);
        out.push(parsed);
      }
      return out;
    },
  };
}

export function createGcsLedger(): ErasureLedger {
  const unavailable = (): never => {
    throw new StorageUnavailableError('The GCS erasure ledger is not implemented yet');
  };
  return { driver: 'gcs', append: async () => unavailable(), readAll: async () => unavailable() };
}
