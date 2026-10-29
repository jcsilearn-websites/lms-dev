import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import autocannon from 'autocannon';
import pg from 'pg';
import { buildApp } from '../src/app';
import { loadDotEnv, parseApiEnv, parseOwnerEnv, resolvePoolMax } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createPasswordHasher } from '../src/core/password';
import { newId } from '../src/core/uuid';
import { createDb } from '../src/db/client';
import { connectionConfig } from '../src/db/connection';
import { deleteTenantCascade } from '../src/db/dev-cleanup';

// GET /members (first page, 50 rows) over HTTP against the DEV database, with a throwaway tenant
// ("bench-<random>") holding MEMBERS members that is deleted in a `finally` block (like bench.ts).
// Remote DB: the numbers include ~200 ms per statement of network and are NOT representative of
// production; the round-trip count (4 per request) is what carries over.
//
//   pnpm --filter @lms/backend run bench:members

const MEMBERS = 5000;

type Row = { reqPerSec: number; p50: number; p99: number; non2xx: number; errors: number };
const toRow = (r: autocannon.Result): Row => ({
  reqPerSec: Math.round(r.requests.average),
  p50: r.latency.p50,
  p99: r.latency.p99,
  non2xx: r.non2xx,
  errors: r.errors,
});

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const owner = new pg.Client(
    connectionConfig(ownerEnv.DATABASE_URL, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
  );
  await owner.connect();

  const suffix = randomBytes(4).toString('hex');
  const slug = `bench-${suffix}`;
  const host = `${slug}.localhost`;
  const email = `admin@${slug}.test`;
  const password = randomBytes(18).toString('hex');
  const tenantId = newId();
  const adminId = newId();
  const hash = await createPasswordHasher({ concurrency: 1 }).hash(password);

  await owner.query('BEGIN');
  await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
    tenantId,
    slug,
    `Bench ${suffix}`,
  ]);
  await owner.query(
    "INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, 'Bench Admin')",
    [adminId, email],
  );
  await owner.query(
    "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'institution_admin')",
    [newId(), tenantId, adminId],
  );
  await owner.query('INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, $2)', [
    adminId,
    hash,
  ]);
  // MEMBERS members with common name prefixes (search keys are filled by the trigger)
  await owner.query(
    `INSERT INTO lms.users (id, email, display_name)
     SELECT gen_random_uuid(), 'm' || g || '@${slug}.test',
            (ARRAY['Asha','Ravi','Priya','Sanjay','Rani','Karthik','Divya','Arun'])[1 + g % 8] || ' Member ' || g
       FROM generate_series(1, ${MEMBERS}) g`,
  );
  await owner.query(
    `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
     SELECT gen_random_uuid(), $1, u.id, 'member', 'active'
       FROM lms.users u WHERE u.email LIKE 'm%@${slug}.test'`,
    [tenantId],
  );
  // academic structure + a student profile for every member: half in section A, half in section B
  const deptId = newId();
  const progId = newId();
  const batchId = newId();
  const secA = newId();
  const secB = newId();
  await owner.query(
    "INSERT INTO lms.departments (id, tenant_id, code, name) VALUES ($1, $2, 'BENCH', 'Bench')",
    [deptId, tenantId],
  );
  await owner.query(
    "INSERT INTO lms.programs (id, tenant_id, department_id, code, name, duration_years) VALUES ($1, $2, $3, 'BP', 'Bench', 4)",
    [progId, tenantId, deptId],
  );
  await owner.query(
    'INSERT INTO lms.batches (id, tenant_id, program_id, admission_year, graduation_year) VALUES ($1, $2, $3, 2023, 2027)',
    [batchId, tenantId, progId],
  );
  await owner.query(
    "INSERT INTO lms.sections (id, tenant_id, batch_id, code) VALUES ($1, $2, $3, 'A'), ($4, $2, $3, 'B')",
    [secA, tenantId, batchId, secB],
  );
  await owner.query(
    `INSERT INTO lms.member_profiles (id, tenant_id, membership_id, profile_type, register_number, batch_id, section_id)
     SELECT gen_random_uuid(), m.tenant_id, m.id, 'student', 'R' || row_number() OVER (ORDER BY m.id), $2,
            CASE WHEN row_number() OVER (ORDER BY m.id) % 2 = 0 THEN $3::uuid ELSE $4::uuid END
       FROM lms.tenant_memberships m WHERE m.tenant_id = $1 AND m.role = 'member'`,
    [tenantId, batchId, secA, secB],
  );
  await owner.query('COMMIT');

  let app: ReturnType<typeof buildApp> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    const env = parseApiEnv({
      ...process.env,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      RATE_LIMIT_MAX: '1000000',
    });
    db = createDb({
      url: env.DATABASE_APP_URL,
      ssl: env.DB_SSL,
      sslCa: env.DB_SSL_CA,
      max: resolvePoolMax(env),
      applicationName: 'lms-bench-members',
    });
    app = buildApp({ env, db, logger: createLogger(env) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const headers = {
      host,
      origin: `http://${host}`,
      'x-requested-with': 'lms',
      'content-type': 'application/json',
    };
    const login = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const body = JSON.stringify({ email, password });
      const req = request(
        `${base}/auth/login`,
        { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          resolve({
            status: res.statusCode ?? 0,
            cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '',
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    if (login.status !== 200) throw new Error(`bench login failed (${login.status})`);

    // autovacuum would have analyzed a tenant this size long before it is read in production: do it now
    await owner.query('ANALYZE lms.users, lms.tenant_memberships, lms.member_profiles');

    // database-side execution time of the real list query, as the app role (RLS on), no network
    const appClient = new pg.Client(
      connectionConfig(env.DATABASE_APP_URL, env.DB_SSL, env.DB_SSL_CA),
    );
    await appClient.connect();
    const listSql = (
      where: string,
    ) => `SELECT m.id, m.user_id, u.email, u.display_name, m.role, m.status, m.created_at,
          p.profile_type, p.register_number, p.employee_id, p.department_id, p.batch_id, p.section_id
        FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
        LEFT JOIN lms.member_profiles p ON p.tenant_id = m.tenant_id AND p.membership_id = m.id
       WHERE m.tenant_id = '${tenantId}'${where} ORDER BY m.id LIMIT 51`;
    const dbTimes: [string, number, number][] = [];
    for (const [name, where] of [
      ['first page (no filter)', ''],
      ["q = 'ra' prefix", " AND (m.search_name LIKE 'ra%' OR m.search_email LIKE 'ra%')"],
      ['role + status filter', " AND m.role = 'member' AND m.status = 'active'"],
      ['section filter (50 rows)', ` AND p.section_id = '${secA}'`],
      [
        'section + profile type filter',
        ` AND p.section_id = '${secB}' AND p.profile_type = 'student'`,
      ],
    ] as const) {
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        await appClient.query(`BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        const r = await appClient.query(`EXPLAIN (ANALYZE) ${listSql(where)}`);
        await appClient.query('ROLLBACK');
        const line = r.rows.map((x) => x['QUERY PLAN']).join(String.fromCharCode(10));
        times.push(Number(/Execution Time: ([\d.]+) ms/.exec(line)?.[1]));
      }
      times.sort((a, b) => a - b);
      dbTimes.push([name, times[7] ?? 0, times[Math.ceil(times.length * 0.95) - 1] ?? 0]);
    }
    await appClient.end();

    const get = (path: string, connections: number) =>
      autocannon({
        url: `${base}${path}`,
        connections,
        duration: 10,
        headers: { host, cookie: login.cookie },
      });
    await get('/members?limit=50', 1).then(() => undefined); // warm the pool (also measured below)

    const rows: [string, Row][] = [];
    for (const [name, path] of [
      ['GET /members?limit=50 (first page)', '/members?limit=50'],
      ['GET /members?limit=50&q=ra (prefix search)', '/members?limit=50&q=ra'],
      [
        'GET /members?limit=50&role=member&status=active',
        '/members?limit=50&role=member&status=active',
      ],
      [
        'GET /members?limit=50&sectionId=<A> (section filter)',
        `/members?limit=50&sectionId=${secA}`,
      ],
    ] as const) {
      rows.push([name, toRow(await get(path, 10))]);
    }
    console.log(
      `\ntenant with ${MEMBERS + 1} members, pool max=${resolvePoolMax(env)}, node ${process.version}; local PostgreSQL`,
    );
    console.log('Database-side execution time of the list query (no network, 15 runs):');
    console.log('| Query | median ms | p95 ms |');
    console.log('|---|---|---|');
    for (const [name, med, p95] of dbTimes) {
      console.log(`| ${name} | ${med.toFixed(2)} | ${p95.toFixed(2)} |`);
    }
    console.log('| Endpoint (c=10, 10 s) | req/sec | p50 ms | p99 ms | non-2xx | errors |');
    console.log('|---|---|---|---|---|---|');
    for (const [name, r] of rows) {
      console.log(`| ${name} | ${r.reqPerSec} | ${r.p50} | ${r.p99} | ${r.non2xx} | ${r.errors} |`);
    }
  } finally {
    await app?.close().catch(() => {});
    await db?.close().catch(() => {});
    try {
      await owner.query('BEGIN');
      await deleteTenantCascade(owner, tenantId);
      await owner.query('COMMIT');
      console.log(`\ncleaned up throwaway tenant ${slug}`);
    } catch (err) {
      await owner.query('ROLLBACK').catch(() => {});
      console.error(
        'cleanup failed (run `pnpm db:dev:clean`):',
        err instanceof Error ? err.message : err,
      );
    }
    await owner.end().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'bench failed');
  process.exit(1);
});
