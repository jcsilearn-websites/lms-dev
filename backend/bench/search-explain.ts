import pg from 'pg';
import { loadDotEnv, parseApiEnv, parseOwnerEnv } from '../src/config/env';
import { connectionConfig } from '../src/db/connection';

// Member-search experiment (step 4): where should the prefix search of GET /members live?
//   A  global indexes on users (lower(display_name), email) + join to the tenant's memberships
//   B  denormalized, lowercased search columns ON tenant_memberships, indexed (tenant_id, key text_pattern_ops)
// Runs EXPLAIN (ANALYZE, BUFFERS) as the app role (RLS on, like production) against a synthetic
// dataset in a THROWAWAY schema (`bench_search`) of the DEV database, then drops the schema. It
// never touches schema `lms`. Numbers are database-side execution times (no network).
//
//   pnpm --filter @lms/backend run bench:search

const SCHEMA = 'bench_search';
const TENANTS = 20;
const USERS = 50_000;
const RUNS = 15;

const FIRST = `ARRAY['aarav','aditi','akash','ananya','anil','anita','arjun','arun','ashok','asha','bala','bharat','chitra','deepa','dinesh','divya','gita','gopal','hari','indu','isha','jaya','jayanth','kamala','karthik','kavya','kiran','lakshmi','mahesh','manoj','meena','mohan','nandini','naveen','neha','nikhil','padma','pooja','prakash','priya','rahul','raj','rajesh','ramesh','rani','ravi','rekha','rohit','sanjay','sara','saravanan','selvi','shalini','shankar','sita','sneha','sunil','suresh','uma','vijay']`;
const LAST = `ARRAY['iyer','nair','pillai','kumar','reddy','rao','sharma','singh','das','menon','patel','gupta','joshi','mehta','shah','verma','bose','ghosh','khan','ali','thomas','joseph','mathew','varghese','naidu','chetty','murthy','krishnan','raman','subramanian']`;

const pgPolicyFns = (s: string) => `
CREATE POLICY users_select ON ${s}.users FOR SELECT TO lms_app
  USING (id = (SELECT lms.current_user_id()) OR EXISTS (
    SELECT 1 FROM ${s}.tenant_memberships m
    WHERE m.user_id = users.id AND m.tenant_id = (SELECT lms.current_tenant_id())));
CREATE POLICY m_all ON ${s}.tenant_memberships FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()));`;

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const appEnv = parseApiEnv({ ...process.env, LOG_LEVEL: 'silent' });
  const owner = new pg.Client(
    connectionConfig(ownerEnv.DATABASE_URL, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
  );
  await owner.connect();
  const app = new pg.Client(
    connectionConfig(appEnv.DATABASE_APP_URL, appEnv.DB_SSL, appEnv.DB_SSL_CA),
  );
  await app.connect();
  try {
    await owner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await owner.query(`CREATE SCHEMA ${SCHEMA}`);
    await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO lms_app`);
    await owner.query(`
      CREATE TABLE ${SCHEMA}.users (
        id uuid PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE ${SCHEMA}.tenant_memberships (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
        role text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        search_name text, search_email text,
        UNIQUE (tenant_id, user_id));
      CREATE TABLE ${SCHEMA}.tenants (id uuid PRIMARY KEY, n int);
    `);
    await owner.query(
      `INSERT INTO ${SCHEMA}.tenants SELECT gen_random_uuid(), g FROM generate_series(1, ${TENANTS}) g`,
    );
    // skewed names (common prefixes) and skewed tenant sizes (the biggest has ~20% of users)
    await owner.query(`
      INSERT INTO ${SCHEMA}.users (id, email, display_name)
      SELECT gen_random_uuid(),
             lower(f || '.' || l || g || '@college' || (g % ${TENANTS}) || '.test'),
             initcap(f) || ' ' || initcap(l)
      FROM (SELECT g,
                   (${FIRST})[1 + floor(random() ^ 1.6 * 60)::int] AS f,
                   (${LAST})[1 + floor(random() ^ 1.3 * 30)::int] AS l
            FROM generate_series(1, ${USERS}) g) s;
      INSERT INTO ${SCHEMA}.tenant_memberships (id, tenant_id, user_id, role, status, search_name, search_email)
      SELECT gen_random_uuid(), t.id, u.id,
             CASE WHEN random() < 0.01 THEN 'institution_admin' ELSE 'member' END,
             CASE WHEN random() < 0.05 THEN 'pending' ELSE 'active' END,
             lower(u.display_name), u.email
      FROM (SELECT u.*, 1 + floor(random() ^ 1.5 * ${TENANTS})::int AS tn FROM ${SCHEMA}.users u) u
      JOIN (SELECT id, n FROM ${SCHEMA}.tenants) t ON t.n = u.tn;
      -- 10% of the users also belong to a second college
      INSERT INTO ${SCHEMA}.tenant_memberships (id, tenant_id, user_id, role, status, search_name, search_email)
      SELECT gen_random_uuid(), t.id, u.id, 'member', 'active', lower(u.display_name), u.email
      FROM (SELECT u.*, 1 + floor(random() * ${TENANTS})::int AS tn FROM ${SCHEMA}.users u WHERE random() < 0.1) u
      JOIN ${SCHEMA}.tenants t ON t.n = u.tn
      ON CONFLICT DO NOTHING;
    `);
    // variant A indexes (global, on users) and variant B indexes (tenant-scoped, on memberships)
    await owner.query(`
      CREATE INDEX a_users_name ON ${SCHEMA}.users (lower(display_name) text_pattern_ops);
      CREATE INDEX a_users_email ON ${SCHEMA}.users (email text_pattern_ops);
      CREATE INDEX b_m_name ON ${SCHEMA}.tenant_memberships (tenant_id, search_name text_pattern_ops);
      CREATE INDEX b_m_email ON ${SCHEMA}.tenant_memberships (tenant_id, search_email text_pattern_ops);
      ALTER TABLE ${SCHEMA}.users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${SCHEMA}.users FORCE ROW LEVEL SECURITY;
      ALTER TABLE ${SCHEMA}.tenant_memberships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${SCHEMA}.tenant_memberships FORCE ROW LEVEL SECURITY;
      ${pgPolicyFns(SCHEMA)}
      GRANT SELECT ON ${SCHEMA}.users, ${SCHEMA}.tenant_memberships TO lms_app;
      ANALYZE ${SCHEMA}.users; ANALYZE ${SCHEMA}.tenant_memberships;
    `);
    const sizes = await owner.query<{ n: number; members: string }>(
      `SELECT t.n, count(*)::text AS members FROM ${SCHEMA}.tenant_memberships m JOIN ${SCHEMA}.tenants t ON t.id = m.tenant_id GROUP BY t.n ORDER BY count(*) DESC`,
    );
    const rows = sizes.rows;
    const tenantIds = async (n: number) =>
      (await owner.query<{ id: string }>(`SELECT id FROM ${SCHEMA}.tenants WHERE n = $1`, [n]))
        .rows[0]?.id as string;
    const big = rows[0];
    const mid = rows[Math.floor(rows.length / 2)];
    if (!big || !mid) throw new Error('no data');
    const users = (await owner.query(`SELECT count(*) AS c FROM ${SCHEMA}.users`)).rows[0].c;
    console.log(
      `dataset: ${TENANTS} tenants, ${users} users, ${rows.reduce((a, r) => a + Number(r.members), 0)} memberships; ` +
        `largest tenant ${big.members} members, median tenant ${mid.members}`,
    );

    const variants: Record<string, string> = {
      A: `SELECT m.id, m.user_id, m.role, m.status, u.email, u.display_name
            FROM ${SCHEMA}.tenant_memberships m JOIN ${SCHEMA}.users u ON u.id = m.user_id
           WHERE m.tenant_id = $1 AND (u.email LIKE $2 OR lower(u.display_name) LIKE $2)
           ORDER BY m.id LIMIT 51`,
      B: `SELECT m.id, m.user_id, m.role, m.status, u.email, u.display_name
            FROM ${SCHEMA}.tenant_memberships m JOIN ${SCHEMA}.users u ON u.id = m.user_id
           WHERE m.tenant_id = $1 AND (m.search_email LIKE $2 OR m.search_name LIKE $2)
           ORDER BY m.id LIMIT 51`,
      none: `SELECT m.id, m.user_id, m.role, m.status, u.email, u.display_name
            FROM ${SCHEMA}.tenant_memberships m JOIN ${SCHEMA}.users u ON u.id = m.user_id
           WHERE m.tenant_id = $1 ORDER BY m.id LIMIT 51`,
    };
    const prefixes = ['ra', 'sa', 'ja', 'san', 'zz'];

    async function explain(sql: string, tenant: string, prefix: string | null, full: boolean) {
      await app.query(`BEGIN; SELECT set_config('app.tenant_id', '${tenant}', true)`);
      const params = prefix === null ? [tenant] : [tenant, `${prefix}%`];
      const r = await app.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS${full ? '' : ', SUMMARY'}) ${sql}`,
        params,
      );
      await app.query('ROLLBACK');
      const lines = r.rows.map((x) => x['QUERY PLAN']);
      const ms = Number(/Execution Time: ([\d.]+) ms/.exec(lines.join('\n'))?.[1] ?? Number.NaN);
      return { ms, lines };
    }

    console.log('\nvariant | tenant | prefix | median ms | p95 ms (DB execution, 15 runs)');
    const worst: Record<string, number> = {};
    for (const [name, sql] of Object.entries(variants)) {
      for (const [label, t] of [
        ['largest', big],
        ['median', mid],
      ] as const) {
        const tenant = await tenantIds(t.n);
        for (const prefix of name === 'none' ? [null] : prefixes) {
          const times: number[] = [];
          for (let i = 0; i < RUNS; i++) times.push((await explain(sql, tenant, prefix, false)).ms);
          const p = p95(times);
          worst[name] = Math.max(worst[name] ?? 0, p);
          console.log(
            `${name} | ${label} | ${prefix ?? '(none)'} | ${median(times).toFixed(2)} | ${p.toFixed(2)}`,
          );
        }
      }
    }
    console.log(
      `\nworst p95 per variant: ${Object.entries(worst)
        .map(([k, v]) => `${k}=${v.toFixed(2)} ms`)
        .join(', ')}`,
    );
    for (const name of ['A', 'B']) {
      const tenant = await tenantIds(big.n);
      const { lines } = await explain(variants[name] as string, tenant, 'ra', true);
      console.log(`\n--- EXPLAIN (ANALYZE, BUFFERS) variant ${name}, largest tenant, q=ra ---`);
      console.log(lines.join('\n'));
    }
  } finally {
    await app.end().catch(() => {});
    await owner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e) => {
      console.error('cleanup failed, drop schema bench_search manually:', e.message);
    });
    await owner.end().catch(() => {});
    console.log(`\ncleaned up schema ${SCHEMA}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'failed');
  process.exit(1);
});
