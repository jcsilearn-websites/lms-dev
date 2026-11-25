// The database roles the application depends on, as a SPECIFICATION, and the checks / repairs of it.
//
// WHY THIS EXISTS. A dump of ONE database (pg_dump) holds tables, functions, policies and grants, but NOT the roles: a role, its
// password and its `ALTER ROLE ... SET` defaults belong to the CLUSTER (pg_dumpall --globals-only). So after a restore into a new cluster:
//   - lms_app may not exist at all (the GRANTs of the dump then fail), or exists with no password and none of its settings
//     (timezone = UTC, jit = off, the timeouts: the app would run with the cluster's zone and with JIT on);
//   - and THE PASSWORD-FINGERPRINT TRAP: `pnpm db:migrate` sets the lms_app password only when the fingerprint stored in
//     lms.role_password_state differs from the one of the environment. That table IS in the dump, so a restored database says
//     "password unchanged" while the new cluster's role has a different password or none: migrate skips ALTER ROLE and the application
//     cannot sign in, with nothing pointing at the cause. restore.mjs deletes the fingerprint after a restore, and `db:verify-roles`
//     tests a REAL login instead of trusting the fingerprint.
// test/migrations.roles.unit.test.ts keeps this specification equal to the migrations.

import { createHash } from 'node:crypto';

export const APP_ROLE = 'lms_app';
export const COMPAT_ROLES = ['anon', 'authenticated'];
/** 0001_schema_and_app_role.sql */
export const APP_ROLE_ATTRIBUTES = {
  rolcanlogin: true,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
};
/** 0001 (the two timeouts) and 0058 (timezone, jit). */
export const APP_ROLE_SETTINGS = {
  statement_timeout: '30s',
  idle_in_transaction_session_timeout: '30s',
  timezone: 'UTC',
  jit: 'off',
};

export const passwordFingerprint = (password) =>
  createHash('sha256').update(`${APP_ROLE}:${password}`).digest('hex');

const ATTRIBUTE_SQL = 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';

/** Creates what is missing (compat roles, lms_app WITHOUT a password). Safe on a cluster that has them. */
export async function ensureRoles(client) {
  for (const r of COMPAT_ROLES) {
    const have = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r]);
    if (!have.rowCount) await client.query(`CREATE ROLE ${r} NOLOGIN`);
  }
  const have = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  if (!have.rowCount) await client.query(`CREATE ROLE ${APP_ROLE} ${ATTRIBUTE_SQL}`);
}

async function roleSettings(client) {
  const r = await client.query(
    `SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles ro ON ro.oid = s.setrole
      WHERE ro.rolname = $1 AND s.setdatabase = 0`,
    [APP_ROLE],
  );
  const out = {};
  for (const entry of r.rows[0]?.setconfig ?? []) {
    // the catalog (and pg_dumpall) spell a setting by its canonical name: `TimeZone`, not `timezone`
    const i = entry.indexOf('=');
    out[entry.slice(0, i).toLowerCase()] = entry.slice(i + 1);
  }
  return out;
}

/** The checks that need only the catalog (owner connection). Returns [{ code, ok, message }]. */
export async function inspectCatalog(client) {
  const findings = [];
  const add = (code, ok, message) => findings.push({ code, ok, message });
  const roles = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY ($1)', [
    [APP_ROLE, ...COMPAT_ROLES],
  ]);
  const have = new Set(roles.rows.map((r) => r.rolname));
  for (const r of [APP_ROLE, ...COMPAT_ROLES])
    add(`role.${r}`, have.has(r), have.has(r) ? `role ${r} exists` : `role ${r} is missing`);
  if (!have.has(APP_ROLE)) return findings;

  const attrs = (
    await client.query(
      `SELECT ${Object.keys(APP_ROLE_ATTRIBUTES).join(', ')} FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    )
  ).rows[0];
  for (const [k, want] of Object.entries(APP_ROLE_ATTRIBUTES)) {
    add(
      `attribute.${k}`,
      attrs[k] === want,
      `${APP_ROLE}.${k} = ${attrs[k]}${attrs[k] === want ? '' : ` (expected ${want})`}`,
    );
  }
  const settings = await roleSettings(client);
  for (const [k, want] of Object.entries(APP_ROLE_SETTINGS)) {
    const got = settings[k];
    add(
      `setting.${k}`,
      got !== undefined && got.toLowerCase() === want.toLowerCase(),
      got === undefined
        ? `${APP_ROLE} has no ${k} default (expected ${want}): a dump alone does not carry role settings`
        : `${APP_ROLE} ${k} = ${got}${got.toLowerCase() === want.toLowerCase() ? '' : ` (expected ${want})`}`,
    );
  }
  const owns = await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'lms' AND r.rolname = $1`,
    [APP_ROLE],
  );
  add(
    'owns-nothing',
    owns.rows[0].n === 0,
    owns.rows[0].n === 0
      ? `${APP_ROLE} owns nothing in schema lms`
      : `${APP_ROLE} owns ${owns.rows[0].n} objects in schema lms`,
  );
  return findings;
}

export async function storedFingerprint(client) {
  const t = await client.query("SELECT to_regclass('lms.role_password_state') AS t");
  if (!t.rows[0].t) return null;
  const r = await client.query(
    "SELECT fingerprint FROM lms.role_password_state WHERE role_name = 'lms_app'",
  );
  return r.rows[0]?.fingerprint ?? null;
}

/** Removes the stored fingerprint, so the next `db:migrate` (or --fix) sets the password for certain. Used right after a restore. */
export async function clearFingerprint(client) {
  const t = await client.query("SELECT to_regclass('lms.role_password_state') AS t");
  if (t.rows[0].t)
    await client.query("DELETE FROM lms.role_password_state WHERE role_name = 'lms_app'");
}

/** Repairs the role: attributes, defaults, the password from the environment, and records its fingerprint (as the migration runner does). */
export async function fixRole(client, appPassword) {
  await ensureRoles(client);
  await client.query(`ALTER ROLE ${APP_ROLE} WITH ${ATTRIBUTE_SQL}`);
  for (const [k, v] of Object.entries(APP_ROLE_SETTINGS)) {
    const { rows } = await client.query('SELECT format($1, $2::text, $3::text) AS sql', [
      'ALTER ROLE lms_app SET %I = %L',
      k,
      v,
    ]);
    await client.query(rows[0].sql);
  }
  const { rows } = await client.query(
    "SELECT format('ALTER ROLE lms_app PASSWORD %L', $1::text) AS sql",
    [appPassword],
  );
  await client.query(rows[0].sql);
  const t = await client.query("SELECT to_regclass('lms.role_password_state') AS t");
  if (t.rows[0].t) {
    await client.query(
      `INSERT INTO lms.role_password_state (role_name, fingerprint) VALUES ('lms_app', $1)
       ON CONFLICT (role_name) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = now()`,
      [passwordFingerprint(appPassword)],
    );
  }
}

/**
 * Applies the part of a `pg_dumpall --globals-only` file that concerns OUR roles: `ALTER ROLE <ours> WITH ...` and `ALTER ROLE <ours>
 * SET ...` (one statement per line, as pg_dumpall writes them). Never CREATE ROLE, never GRANT, never another role, never a database-specific
 * setting (it names the source database). Returns how many statements were applied.
 */
export async function applyOurGlobals(client, globalsSql) {
  const ours = [APP_ROLE, ...COMPAT_ROLES].join('|');
  const re = new RegExp(`^ALTER ROLE (?:${ours}) (?:WITH|SET|RESET) .*;$`);
  let applied = 0;
  for (const line of globalsSql.split(/\r?\n/)) {
    if (!re.test(line) || /\bPASSWORD\b/i.test(line)) continue;
    await client.query(line);
    applied++;
  }
  return applied;
}
