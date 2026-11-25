// pnpm db:restore --backup <folder> [--finish] [--globals] [--replace --confirm <database>]
//
// Restores a backup made by db:backup into the database named by RESTORE_DATABASE_URL (an OWNER / superuser connection of the TARGET cluster,
// database name included; never DATABASE_URL: restoring is never done by accident into the configured database).
//
// In this order (each step stops the run when it fails):
//   1. every file of the backup is checked against the manifest (SHA-256, size): a damaged backup is refused before anything is touched
//   2. the target: created when missing; when it holds tables, refused unless --replace --confirm <its name> (then dropped and created again)
//   3. the cluster's roles exist (anon, authenticated, lms_app without a password) so that the GRANTs of the dump have somebody to go to;
//      with --globals the ALTER ROLE statements of globals.sql for THOSE roles are applied (defaults of lms_app); nothing else of it
//   4. pg_restore --single-transaction --exit-on-error --no-owner: all or nothing; the restoring user owns the objects
//   5. THE PASSWORD-FINGERPRINT TRAP: the stored fingerprint of the lms_app password came with the dump and says "unchanged" about a role of
//      ANOTHER cluster: it is deleted, so the next db:migrate (or the repair below) really sets the password
//   6. the restored state is compared with the manifest: row counts of every table, row-level security enabled AND forced, migrations,
//      grants, functions (SET clauses, ACLs), policies, triggers, indexes, constraints, the unlogged tables empty
// With --finish it then goes on (needs LMS_APP_PASSWORD; the target's lms_app URL is derived from RESTORE_DATABASE_URL):
//   7. db:verify-roles --fix      the role: attributes, defaults, password, a REAL sign-in
//   8. db:migrate                 brings an older backup up to the current schema (and checks the migration checksums)
//   9. privacy:reapply-erasures   the erasure ledger: everyone erased since the backup was taken is erased AGAIN
// Do NOT start the application on a restored database before step 9 has run (docs/backup-and-restore.md).
//
// Environment: RESTORE_DATABASE_URL, DB_SSL / DB_SSL_CA, PG_BIN_DIR; for --finish also LMS_APP_PASSWORD and the application's own
// variables (the ledger location, SUPPRESSION_HASH_KEYS, ...), exactly as the application runs.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readVerifiedBackup } from './backup.mjs';
import {
  assertServerMajor,
  collectState,
  compareState,
  connect,
  findPgTool,
  loadEnv,
  need,
  parseDbUrl,
  pgEnv,
  REPO_ROOT,
  run,
  runChecked,
  unloggedAreEmpty,
  withCredentials,
  withDatabase,
} from './lib.mjs';
import { applyOurGlobals, clearFingerprint, ensureRoles } from './roles.mjs';
import { verifyRoles } from './verify-roles.mjs';

const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const quote = (n) => `"${n}"`; // only ever called with a name that passed SAFE_NAME

export class RestoreError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

async function prepareTarget(targetUrl, replace, confirm, log) {
  const t = parseDbUrl(targetUrl);
  if (!SAFE_NAME.test(t.database))
    throw new RestoreError(
      `the target database name "${t.database}" is not a plain lowercase identifier`,
    );
  const admin = await connect(withDatabase(targetUrl, 'postgres'), 'lms-restore');
  try {
    assertServerMajor(
      (await admin.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,
      'the target server',
    );
    const exists =
      (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [t.database])).rowCount >
      0;
    if (exists) {
      const probe = await connect(targetUrl, 'lms-restore-probe');
      let tables;
      try {
        tables = Number(
          (
            await probe.query(
              "SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'lms' AND c.relkind IN ('r', 'p')",
            )
          ).rows[0].n,
        );
      } finally {
        await probe.end().catch(() => {});
      }
      if (tables > 0) {
        if (!replace)
          throw new RestoreError(
            `database ${t.database} already holds ${tables} tables of the application: restoring needs --replace --confirm ${t.database}`,
          );
        if (confirm !== t.database)
          throw new RestoreError(`--replace needs --confirm ${t.database} (typed exactly)`);
        log(`dropping database ${t.database} (--replace)`);
        await admin.query(`DROP DATABASE ${quote(t.database)} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${quote(t.database)}`);
      }
    } else {
      await admin.query(`CREATE DATABASE ${quote(t.database)}`);
      log(`database ${t.database} created`);
    }
    await ensureRoles(admin);
    return admin.end().then(() => t);
  } catch (err) {
    await admin.end().catch(() => {});
    throw err;
  }
}

export async function restore({
  backupDir,
  targetUrl,
  replace = false,
  confirm,
  globals = false,
  log = () => {},
}) {
  const secrets = [parseDbUrl(targetUrl).password];
  const manifest = await readVerifiedBackup(backupDir).catch((err) => {
    throw new RestoreError(`the backup is refused: ${err.message}`, 3);
  });
  log(
    `backup verified: ${Object.keys(manifest.files).length} files match the manifest (taken ${manifest.createdAt} from ${manifest.source.database})`,
  );
  const pgRestore = await findPgTool('pg_restore');
  const target = await prepareTarget(targetUrl, replace, confirm, log);

  if (globals) {
    const admin = await connect(withDatabase(targetUrl, 'postgres'), 'lms-restore-globals');
    try {
      const n = await applyOurGlobals(
        admin,
        await readFile(join(backupDir, 'globals.sql'), 'utf8'),
      );
      log(`globals.sql: ${n} ALTER ROLE statement(s) for our roles applied`);
    } finally {
      await admin.end().catch(() => {});
    }
  }

  await runChecked(
    pgRestore,
    [
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--dbname',
      target.database,
      join(backupDir, 'database.dump'),
    ],
    {
      env: pgEnv(targetUrl, 'lms-restore'),
      secrets,
    },
  ).catch((err) => {
    throw new RestoreError(
      `pg_restore failed, nothing was restored (single transaction): ${err.message}`,
      4,
    );
  });
  log('database restored');

  const client = await connect(targetUrl, 'lms-restore-verify');
  try {
    await clearFingerprint(client);
    log(
      'the stored lms_app password fingerprint was cleared (it belongs to the cluster the backup came from)',
    );
  } finally {
    await client.end().catch(() => {});
  }
  log(await verifyRestored(targetUrl, manifest));
  return { manifest, database: target.database };
}

/**
 * Compares a database with the state recorded in a backup's manifest (row counts, row-level security, migrations, grants, functions, policies,
 * triggers, indexes, constraints, unlogged tables empty). Throws a RestoreError (exit code 5) listing every difference.
 * Only meaningful straight after the restore: a database in use has moved on (db:verify-restore says so).
 */
export async function verifyRestored(targetUrl, manifest) {
  const client = await connect(targetUrl, 'lms-restore-verify');
  try {
    const actual = await collectState(client);
    const failures = [
      ...compareState(manifest.state, actual),
      ...(await unloggedAreEmpty(client, actual)),
    ];
    if (failures.length)
      throw new RestoreError(
        `the restored database differs from the backup:\n  - ${failures.join('\n  - ')}`,
        5,
      );
    const rows = Object.values(actual.counts).reduce((a, b) => a + b, 0);
    return `restored state matches the manifest: ${actual.tables.length} tables, ${rows} rows, ${actual.migrations.count} migrations, every catalog digest equal`;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Steps 7-9 against the restored database. */
export async function finish({ targetUrl, log = () => {} }) {
  const appPassword = need('LMS_APP_PASSWORD');
  const t = parseDbUrl(targetUrl);
  const appUrl = withCredentials(targetUrl, 'lms_app', appPassword);
  const roles = await verifyRoles({ ownerUrl: targetUrl, appUrl, appPassword, fix: true, log });
  if (!roles.ok) throw new RestoreError('the roles are still wrong after the repair', 6);
  const env = { DATABASE_URL: targetUrl, DATABASE_APP_URL: appUrl, LMS_APP_PASSWORD: appPassword };
  const secrets = [t.password, appPassword];
  const shell = process.platform === 'win32'; // pnpm is a .cmd file there
  const migrate = await run('pnpm', ['db:migrate'], { env, cwd: REPO_ROOT, secrets, shell });
  log(migrate.stdout.trim().split('\n').slice(-3).join('\n'));
  if (migrate.code !== 0) throw new RestoreError(`db:migrate failed:\n${migrate.stderr.trim()}`, 7);
  const reapply = await run('pnpm', ['privacy:reapply-erasures', '--yes'], {
    env,
    cwd: REPO_ROOT,
    secrets,
    shell,
  });
  log(reapply.stdout.trim().split('\n').slice(-3).join('\n'));
  if (reapply.code === 2)
    throw new RestoreError(
      'the erasure ledger is only partly applied (an account waits for its college): run `pnpm privacy:reapply-erasures --yes` again until it exits 0',
      2,
    );
  if (reapply.code !== 0)
    throw new RestoreError(`the erasure ledger could not be applied:\n${reapply.stderr.trim()}`, 8);
}

async function main() {
  const { values } = parseArgs({
    options: {
      backup: { type: 'string' },
      finish: { type: 'boolean', default: false },
      globals: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      confirm: { type: 'string' },
    },
    strict: true,
  });
  loadEnv();
  if (!values.backup) throw new RestoreError('--backup <folder made by db:backup> is required');
  const targetUrl = need('RESTORE_DATABASE_URL');
  const log = (m) => console.log(m);
  await restore({
    backupDir: resolve(values.backup),
    targetUrl,
    replace: values.replace,
    confirm: values.confirm,
    globals: values.globals,
    log,
  });
  if (values.finish) {
    await finish({ targetUrl, log });
    console.log(
      'restore finished: roles verified, migrated, erasure ledger applied. The application may be started on this database.',
    );
  } else {
    console.log(
      'restored. NOT finished: run db:verify-roles --fix, db:migrate and privacy:reapply-erasures before starting the application (or use --finish).',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'restore failed');
    process.exit(err?.exitCode ?? 1);
  });
}
