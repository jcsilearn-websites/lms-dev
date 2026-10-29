import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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

// Benchmarks the real app over HTTP on an ephemeral port against the DEV database. Everything that
// touches the database includes the network hop to the remote (Supabase) server, so those numbers
// are not representative of production.
//
// The benchmark owns its data: it creates a throwaway tenant ("bench-<random>") with one member
// through the OWNER connection, and deletes the tenant, its member, sessions and audit rows in a
// `finally` block, so it leaves nothing behind (`pnpm db:dev:clean` also removes stragglers from a
// crashed run). It uses the dev DB rather than the test DB because that is what the real app
// config talks to, and the test DB is truncated by test runs.

type Row = { reqPerSec: number; p50: number; p99: number; non2xx: number; errors: number };

function toRow(result: autocannon.Result): Row {
  return {
    reqPerSec: Math.round(result.requests.average),
    p50: result.latency.p50,
    p99: result.latency.p99,
    non2xx: result.non2xx,
    errors: result.errors,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const ownerEnv = parseOwnerEnv();
  const owner = new pg.Client(
    connectionConfig(ownerEnv.DATABASE_URL, ownerEnv.DB_SSL, ownerEnv.DB_SSL_CA),
  );
  await owner.connect();

  // ---- throwaway tenant + member (owner connection)
  const suffix = randomBytes(4).toString('hex');
  const slug = `bench-${suffix}`;
  const host = `${slug}.localhost`;
  const email = `bench@${slug}.test`;
  const password = randomBytes(18).toString('hex');
  const tenantId = newId();
  const userId = newId();
  const passwordHash = await createPasswordHasher({ concurrency: 1 }).hash(password);
  await owner.query('BEGIN');
  await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
    tenantId,
    slug,
    `Bench ${suffix}`,
  ]);
  await owner.query(
    "INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, 'Bench User')",
    [userId, email],
  );
  await owner.query(
    "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')",
    [newId(), tenantId, userId],
  );
  await owner.query('INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, $2)', [
    userId,
    passwordHash,
  ]);
  await owner.query('COMMIT');

  let app: ReturnType<typeof buildApp> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    const env = parseApiEnv({
      ...process.env,
      LOG_LEVEL: 'silent',
      // the benchmark logs in hundreds of times from one IP
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      RATE_LIMIT_MAX: '1000000',
    });
    db = createDb({
      url: env.DATABASE_APP_URL,
      ssl: env.DB_SSL,
      sslCa: env.DB_SSL_CA,
      max: resolvePoolMax(env),
      applicationName: 'lms-bench',
    });
    app = buildApp({ env, db, logger: createLogger(env) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const browser = {
      host,
      origin: `http://${host}`,
      'x-requested-with': 'lms',
      'content-type': 'application/json',
    };

    // one real login to obtain a session cookie for the /auth/me benchmark (its cost is excluded).
    // node:http (not fetch): fetch refuses to send a custom Host header, and the Host selects the tenant.
    const login = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const body = JSON.stringify({ email, password });
      const req = request(
        `${base}/auth/login`,
        { method: 'POST', headers: { ...browser, 'content-length': Buffer.byteLength(body) } },
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

    await autocannon({ url: `${base}/health/ready`, connections: 1, amount: 3 }); // warm pool/TLS
    const live = (connections: number, duration: number) =>
      autocannon({ url: `${base}/health/live`, connections, duration });

    const rows: [string, Row][] = [];
    rows.push(['GET /health/live (c=50, 10s)', toRow(await live(50, 10))]);
    rows.push([
      'GET /auth/me, authenticated (c=10, 10s) [DB]',
      toRow(
        await autocannon({
          url: `${base}/auth/me`,
          connections: 10,
          duration: 10,
          headers: { host, cookie: login.cookie },
        }),
      ),
    ]);

    // login is intentionally CPU-heavy (argon2id); measured separately...
    const loginOpts = {
      url: `${base}/auth/login`,
      method: 'POST' as const,
      headers: browser,
      body: JSON.stringify({ email, password }),
    };
    rows.push([
      'POST /auth/login (c=4, 15s) [DB + argon2id]',
      toRow(await autocannon({ ...loginOpts, connections: 4, duration: 15 })),
    ]);

    // ...and then together with /health/live to show it does not block other requests
    const liveBaseline = toRow(await live(20, 10));
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const [loginMixed, liveUnderLogin] = await Promise.all([
      autocannon({ ...loginOpts, connections: 4, duration: 10 }),
      live(20, 10),
    ]);
    loop.disable();

    console.log(
      `\npool max=${resolvePoolMax(env)}, node ${process.version}, UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? 'default(4)'}`,
    );
    console.log('| Endpoint | req/sec | p50 ms | p99 ms | non-2xx | errors |');
    console.log('|---|---|---|---|---|---|');
    for (const [name, r] of rows) {
      console.log(`| ${name} | ${r.reqPerSec} | ${r.p50} | ${r.p99} | ${r.non2xx} | ${r.errors} |`);
    }
    const under = toRow(liveUnderLogin);
    const lm = toRow(loginMixed);
    console.log('\nConcurrency check (login load running while /health/live is measured):');
    console.log('| Scenario | req/sec | p50 ms | p99 ms | non-2xx |');
    console.log('|---|---|---|---|---|');
    console.log(
      `| /health/live alone (c=20) | ${liveBaseline.reqPerSec} | ${liveBaseline.p50} | ${liveBaseline.p99} | ${liveBaseline.non2xx} |`,
    );
    console.log(
      `| /health/live during login load (c=20) | ${under.reqPerSec} | ${under.p50} | ${under.p99} | ${under.non2xx} |`,
    );
    console.log(
      `| POST /auth/login during that run (c=4) | ${lm.reqPerSec} | ${lm.p50} | ${lm.p99} | ${lm.non2xx} |`,
    );
    console.log(
      `event loop delay while hashing: p50 ${(loop.percentile(50) / 1e6).toFixed(1)} ms, p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms, max ${(loop.max / 1e6).toFixed(1)} ms`,
    );
  } finally {
    await app?.close().catch(() => {});
    await db?.close().catch(() => {});
    // remove the throwaway tenant, its member, sessions and audit rows
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
