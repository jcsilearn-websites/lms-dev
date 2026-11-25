// pnpm db:verify-roles [--fix]
//
// Checks that the DATABASE ROLES the application needs are in the state the migrations leave them in, by a REAL sign-in of lms_app with
// the password of the environment (never by trusting the fingerprint of lms.role_password_state: see roles.mjs, "the password-fingerprint
// trap"). Run it after every restore and after moving to a new cluster. With --fix it repairs the role (attributes, defaults, password,
// fingerprint) and checks again. Exit code 0 when everything is right, 1 otherwise.
//
// Environment: DATABASE_URL (owner), DATABASE_APP_URL, LMS_APP_PASSWORD (must equal the password inside DATABASE_APP_URL), DB_SSL / DB_SSL_CA.

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clientConfig, connect, loadEnv, need, parseDbUrl, pg, redact } from './lib.mjs';
import {
  APP_ROLE,
  APP_ROLE_SETTINGS,
  fixRole,
  inspectCatalog,
  passwordFingerprint,
  storedFingerprint,
} from './roles.mjs';

/** A real sign-in as lms_app: who am I, are the defaults in force, am I NOT able to bypass row-level security. */
async function checkLogin(appUrl, appPassword) {
  const findings = [];
  const add = (code, ok, message) => findings.push({ code, ok, message });
  const client = new pg.Client({ ...clientConfig(appUrl), application_name: 'lms-verify-roles' });
  try {
    await client.connect();
  } catch (err) {
    const why =
      err.code === '28P01'
        ? 'the password is not accepted'
        : err.code === '28000'
          ? 'the role does not exist or may not connect'
          : (err.code ?? err.message);
    add(
      'login',
      false,
      `${APP_ROLE} cannot sign in with the password of the environment (${redact(String(why), [appPassword])})`,
    );
    return findings;
  }
  try {
    add('login', true, `${APP_ROLE} signs in with the password of the environment`);
    const me = (
      await client.query(
        "SELECT current_user AS u, current_setting('timezone') AS tz, current_setting('jit') AS jit, current_setting('statement_timeout') AS st, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass",
      )
    ).rows[0];
    add('login.user', me.u === APP_ROLE, `connected as ${me.u}`);
    add(
      'login.bypass',
      me.bypass === false,
      me.bypass
        ? `${APP_ROLE} can bypass row-level security`
        : `${APP_ROLE} cannot bypass row-level security`,
    );
    add(
      'login.timezone',
      me.tz === APP_ROLE_SETTINGS.timezone,
      `a new connection runs in time zone ${me.tz}`,
    );
    add('login.jit', me.jit === APP_ROLE_SETTINGS.jit, `a new connection has jit = ${me.jit}`);
    add(
      'login.statement_timeout',
      me.st === APP_ROLE_SETTINGS.statement_timeout,
      `a new connection has statement_timeout = ${me.st}`,
    );
    // row-level security in force for this very login: without a tenant set, a tenant table is empty
    const t = await client.query("SELECT to_regclass('lms.tenant_memberships') AS t");
    if (t.rows[0].t) {
      const n = Number(
        (await client.query('SELECT count(*) AS n FROM lms.tenant_memberships')).rows[0].n,
      );
      add(
        'login.rls',
        n === 0,
        n === 0
          ? 'with no tenant set a tenant table is empty (row-level security is in force)'
          : `with no tenant set ${APP_ROLE} sees ${n} membership rows`,
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
  return findings;
}

export async function verifyRoles({ ownerUrl, appUrl, appPassword, fix = false, log = () => {} }) {
  const secrets = [appPassword, parseDbUrl(ownerUrl).password];
  const owner = await connect(ownerUrl, 'lms-verify-roles');
  try {
    const gather = async () => {
      const findings = await inspectCatalog(owner);
      const stored = await storedFingerprint(owner);
      const login = await checkLogin(appUrl, appPassword);
      findings.push(...login);
      if (stored !== null) {
        const same = stored === passwordFingerprint(appPassword);
        const loginOk = login.find((f) => f.code === 'login')?.ok;
        if (same && loginOk === false) {
          findings.push({
            code: 'fingerprint-trap',
            ok: false,
            message:
              'THE FINGERPRINT SAYS "PASSWORD UNCHANGED" BUT THE ROLE DOES NOT ACCEPT IT (db:migrate would skip ALTER ROLE): --fix resets the password and the fingerprint',
          });
        } else {
          findings.push({
            code: 'fingerprint',
            ok: true,
            message: same
              ? 'the stored fingerprint matches the environment'
              : 'the stored fingerprint differs from the environment (db:migrate will set the password)',
          });
        }
      } else {
        findings.push({
          code: 'fingerprint',
          ok: true,
          message: 'no stored fingerprint (db:migrate or --fix sets the password)',
        });
      }
      return findings;
    };
    let findings = await gather();
    let fixed = false;
    if (fix && findings.some((f) => !f.ok)) {
      log('repairing the role ...');
      await fixRole(owner, appPassword);
      fixed = true;
      findings = await gather();
    }
    for (const f of findings) log(`${f.ok ? 'ok  ' : 'FAIL'} ${redact(f.message, secrets)}`);
    return { ok: findings.every((f) => f.ok), findings, fixed };
  } finally {
    await owner.end().catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({
    options: { fix: { type: 'boolean', default: false } },
    strict: true,
  });
  loadEnv();
  const appUrl = need('DATABASE_APP_URL');
  const appPassword = need('LMS_APP_PASSWORD');
  if (parseDbUrl(appUrl).password !== appPassword)
    throw new Error('LMS_APP_PASSWORD must equal the password inside DATABASE_APP_URL');
  const r = await verifyRoles({
    ownerUrl: need('DATABASE_URL'),
    appUrl,
    appPassword,
    fix: values.fix,
    log: (m) => console.log(m),
  });
  if (r.ok) console.log(r.fixed ? 'roles: repaired and verified' : 'roles: verified');
  else
    console.log(
      values.fix
        ? 'roles: STILL WRONG after the repair'
        : 'roles: wrong. Run `pnpm db:verify-roles --fix`.',
    );
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'failed');
    process.exit(1);
  });
}
