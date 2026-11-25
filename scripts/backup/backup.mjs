// pnpm db:backup --out <dir> [--keep-days 30 | --no-prune] [--role-passwords]
//
// A LOGICAL backup of the database named in DATABASE_URL (owner connection), for disaster recovery and for moving to another cluster.
// On Cloud SQL the primary recovery tool is point-in-time recovery (docs/backup-and-restore.md); this is the second, independent copy.
//
// What it writes, in <out>/lms-<database>-<UTC time>/ :
//   database.dump   pg_dump -Fc of the whole database, taken from the SAME snapshot as the row counts in the manifest
//                   (UNLOGGED tables, the rate-limit counters, are dumped without data: a crash empties them as well)
//   globals.sql     pg_dumpall --globals-only: the cluster's roles, their attributes and their ALTER ROLE ... SET defaults.
//                   WITHOUT password hashes unless --role-passwords is given (the application's password comes from the environment).
//   manifest.json   what is in the backup: versions, per-file SHA-256, exact row counts, migrations, a digest of every kind of
//                   catalog object (grants, functions with their SET clauses, policies, triggers, indexes, constraints)
//   SHA256SUMS      `sha256sum -c` compatible
// The folder is written as <name>.partial and renamed when complete: a backup that crashed half way never looks like one.
// Backups contain personal data: keep them where the database itself would be kept (they are git-ignored here).
// --keep-days N removes backup folders of this tool that are older than N days (default 30, the window in docs/data-retention.md).
//
// Environment: DATABASE_URL (owner), DB_SSL / DB_SSL_CA, PG_BIN_DIR (the PostgreSQL 17 tools when they are not on PATH).

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertServerMajor,
  collectState,
  connect,
  findPgTool,
  loadEnv,
  MANIFEST_VERSION,
  need,
  parseDbUrl,
  pgEnv,
  runChecked,
  sha256File,
  timestampName,
  toolMajor,
} from './lib.mjs';

const FOLDER = /^lms-([a-z][a-z0-9_]*)-(\d{8}T\d{6}Z)$/;
const DAY_MS = 86_400_000;

function folderTime(name) {
  const m = FOLDER.exec(name);
  if (!m) return null;
  const t = m[2];
  return Date.parse(
    `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`,
  );
}

/** Deletes complete backup folders (name pattern AND a manifest inside) older than keepDays. Never touches anything else. */
export async function pruneBackups(outDir, keepDays, now = Date.now()) {
  const removed = [];
  for (const name of await readdir(outDir).catch(() => [])) {
    const at = folderTime(name);
    if (at === null || now - at <= keepDays * DAY_MS) continue;
    const dir = join(outDir, name);
    if (!(await stat(join(dir, 'manifest.json')).catch(() => null))) continue;
    await rm(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Writes SHA256SUMS in the format `sha256sum -c` reads. */
const sumsText = (files) =>
  `${Object.entries(files)
    .map(([f, v]) => `${v.sha256}  ${f}`)
    .join('\n')}\n`;

export async function backup({ ownerUrl, outDir, rolePasswords = false, log = () => {} }) {
  const db = parseDbUrl(ownerUrl);
  const secrets = [db.password];
  const [pgDump, pgDumpall] = await Promise.all([findPgTool('pg_dump'), findPgTool('pg_dumpall')]);
  const env = pgEnv(ownerUrl, 'lms-backup');
  await mkdir(outDir, { recursive: true });
  const name = `lms-${db.database}-${timestampName()}`;
  const partial = join(outDir, `${name}.partial`);
  const finalDir = join(outDir, name);

  const client = await connect(ownerUrl, 'lms-backup-snapshot'); // a refused connection leaves nothing behind: the folder comes after it
  await mkdir(partial, { recursive: true });
  try {
    const { server_version_num: versionNum, server_version: serverVersion } = (
      await client.query(
        "SELECT current_setting('server_version_num') AS server_version_num, current_setting('server_version') AS server_version",
      )
    ).rows[0];
    assertServerMajor(versionNum, `the server of ${db.database}`);

    // One snapshot for the counts AND for pg_dump (--snapshot): the manifest describes exactly what the dump holds.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
    const state = await collectState(client);
    log(`snapshot taken: ${state.tables.length} tables, ${state.migrations.count} migrations`);

    await runChecked(
      pgDump,
      [
        '--format=custom',
        '--compress=6',
        '--no-unlogged-table-data',
        `--snapshot=${snapshot}`,
        '--file',
        join(partial, 'database.dump'),
      ],
      { env, secrets },
    );
    await client.query('COMMIT');
    log('database.dump written');

    await runChecked(
      pgDumpall,
      [
        '--globals-only',
        ...(rolePasswords ? [] : ['--no-role-passwords']),
        '--database',
        db.database,
        '--file',
        join(partial, 'globals.sql'),
      ],
      { env, secrets },
    );
    log(
      `globals.sql written${rolePasswords ? ' WITH role password hashes (guard this file like a secret)' : ''}`,
    );

    const files = {};
    for (const f of ['database.dump', 'globals.sql']) {
      const p = join(partial, f);
      files[f] = { bytes: (await stat(p)).size, sha256: await sha256File(p) };
    }
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      source: { database: db.database, host: db.host, serverVersion },
      tools: {
        pg_dump: (await runChecked(pgDump, ['--version'])).stdout.trim(),
        pg_dumpall_major: await toolMajor(pgDumpall),
      },
      rolePasswordsIncluded: rolePasswords,
      files,
      state,
    };
    await writeFile(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(partial, 'SHA256SUMS'), sumsText(files));
    for (const f of ['database.dump', 'globals.sql', 'manifest.json', 'SHA256SUMS'])
      await chmod(join(partial, f), 0o600).catch(() => {});
    await rename(partial, finalDir);
    return { dir: finalDir, manifest };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Reads a backup folder and checks every file against the manifest. Throws on the first mismatch: nothing is restored from a damaged backup. */
export async function readVerifiedBackup(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.manifestVersion !== MANIFEST_VERSION)
    throw new Error(`manifest version ${manifest.manifestVersion} is not supported`);
  for (const [f, v] of Object.entries(manifest.files)) {
    const p = join(dir, f);
    const s = await stat(p).catch(() => null);
    if (!s) throw new Error(`${f} is missing from the backup`);
    if (s.size !== v.bytes)
      throw new Error(
        `${f}: the size differs from the manifest (${s.size} bytes, expected ${v.bytes})`,
      );
    if ((await sha256File(p)) !== v.sha256)
      throw new Error(
        `${f}: the SHA-256 differs from the manifest (the file is damaged or was changed)`,
      );
  }
  const sums = await readFile(join(dir, 'SHA256SUMS'), 'utf8').catch(() => '');
  for (const [f, v] of Object.entries(manifest.files)) {
    if (!sums.includes(`${v.sha256}  ${f}`))
      throw new Error(`SHA256SUMS does not agree with the manifest for ${f}`);
  }
  return manifest;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'keep-days': { type: 'string' },
      'no-prune': { type: 'boolean', default: false },
      'role-passwords': { type: 'boolean', default: false },
    },
    strict: true,
  });
  loadEnv();
  if (!values.out)
    throw new Error(
      '--out <directory> is required (outside the repository, or the git-ignored ./backups)',
    );
  const outDir = resolve(values.out);
  const keepDays = values['keep-days'] === undefined ? 30 : Number(values['keep-days']);
  if (!Number.isFinite(keepDays) || keepDays < 1)
    throw new Error('--keep-days must be a number of days, 1 or more');
  const r = await backup({
    ownerUrl: need('DATABASE_URL'),
    outDir,
    rolePasswords: values['role-passwords'],
    log: (m) => console.log(m),
  });
  const total = Object.values(r.manifest.files).reduce((s, f) => s + f.bytes, 0);
  console.log(
    `backup complete: ${r.dir} (${total} bytes, ${Object.keys(r.manifest.state.counts).length} tables with data counted)`,
  );
  if (!values['no-prune']) {
    const removed = await pruneBackups(outDir, keepDays);
    if (removed.length)
      console.log(
        `removed ${removed.length} backup(s) older than ${keepDays} days: ${removed.join(', ')}`,
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'backup failed');
    process.exit(1);
  });
}
