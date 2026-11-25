// pnpm db:verify-restore --backup <folder>
//
// Compares the database named by RESTORE_DATABASE_URL with the state recorded in a backup's manifest: row counts of every table, row-level
// security enabled AND forced, the applied migrations and their checksums, grants, functions with their SET clauses and ACLs, policies,
// triggers, indexes, constraints, the unlogged tables empty. db:restore runs this itself; run it alone to check a restore somebody else
// did, or to prove the check has teeth (change something in the restored copy and it must exit 5).
// Only meaningful on a database nothing has written to since the restore (a later migration or erasure changes counts and catalogs).

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readVerifiedBackup } from './backup.mjs';
import { loadEnv, need } from './lib.mjs';
import { verifyRestored } from './restore.mjs';

async function main() {
  const { values } = parseArgs({ options: { backup: { type: 'string' } }, strict: true });
  loadEnv();
  if (!values.backup) throw new Error('--backup <folder made by db:backup> is required');
  const manifest = await readVerifiedBackup(resolve(values.backup));
  console.log(await verifyRestored(need('RESTORE_DATABASE_URL'), manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'verification failed');
    process.exit(err?.exitCode ?? 1);
  });
}
