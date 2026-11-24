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

export interface LedgerEntry {
  v: 1;
  requestId: string;
  tenantId: string;
  membershipId: string;
  userId: string;
  level: 'college';
  /** when the erasure was executed (ISO) */
  at: string;
}

export interface ErasureLedger {
  readonly driver: 'local' | 'gcs';
  /** Appends one entry durably (flushed to disk). Appending the same request twice is harmless: readers de-duplicate. */
  append(entry: LedgerEntry): Promise<void>;
  /** Every entry, oldest first, one per request. */
  readAll(): Promise<LedgerEntry[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const valid = (e: unknown): e is LedgerEntry => {
  const x = e as Partial<LedgerEntry> | null;
  return (
    !!x &&
    x.v === 1 &&
    x.level === 'college' &&
    [x.requestId, x.tenantId, x.membershipId, x.userId].every(
      (s) => typeof s === 'string' && UUID.test(s),
    ) &&
    typeof x.at === 'string' &&
    !Number.isNaN(Date.parse(x.at))
  );
};

export function createLocalLedger(opts: { dir: string }): ErasureLedger {
  const file = path.resolve(opts.dir, 'erasure-ledger.jsonl');
  return {
    driver: 'local',
    async append(entry) {
      if (!valid(entry)) throw new Error('invalid ledger entry');
      await mkdir(path.dirname(file), { recursive: true });
      // ONLY the seven known fields are written, whatever the caller passes: the ledger can never hold a name or an address
      const clean: LedgerEntry = {
        v: 1,
        requestId: entry.requestId,
        tenantId: entry.tenantId,
        membershipId: entry.membershipId,
        userId: entry.userId,
        level: 'college',
        at: entry.at,
      };
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
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
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
