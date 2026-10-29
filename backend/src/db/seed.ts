import pg from 'pg';
import { EnvError, loadDotEnv, parseMigrateEnv } from '../config/env';
import { redactSecrets } from '../config/secrets';
import { sslWarning } from '../config/ssl';
import { createPasswordHasher } from '../core/password';
import { newId } from '../core/uuid';
import { connectionConfig } from './connection';

// Idempotent dev seed, run as the owner role (never as lms_app): 1 platform admin and
// 2 demo tenants, each with 1 institution_admin and several members.
const PLATFORM_ADMIN = { email: 'platform.admin@jcsilearn.example', name: 'Platform Admin' };
const TENANTS = [
  { slug: 'alpha-college', name: 'Alpha College' },
  { slug: 'beta-institute', name: 'Beta Institute' },
];
const MEMBER_COUNT = 4;

async function setPassword(client: pg.Client, userId: string, hash: string) {
  await client.query(
    `INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, password_updated_at = now(),
           failed_attempts = 0, locked_until = NULL, updated_at = now()`,
    [userId, hash],
  );
}

async function upsertUser(client: pg.Client, email: string, name: string, admin: boolean) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO lms.users (id, email, display_name, is_platform_admin)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [newId(), email, name, admin],
  );
  return rows[0]?.id as string;
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseMigrateEnv();
  // Seeded accounts all get the same known dev password: never seed a production database.
  if (env.NODE_ENV === 'production') {
    throw new EnvError(['NODE_ENV: the seed refuses to run when NODE_ENV=production']);
  }
  if (!env.SEED_USER_PASSWORD) {
    throw new EnvError([
      'SEED_USER_PASSWORD: required to seed (dev-only password for seeded users)',
    ]);
  }
  const seedPassword = env.SEED_USER_PASSWORD;
  const hasher = createPasswordHasher({ concurrency: 2 });
  const warn = sslWarning(env);
  if (warn) console.warn(`WARNING: ${warn}`);
  const client = new pg.Client(connectionConfig(env.DATABASE_URL, env.DB_SSL, env.DB_SSL_CA));
  await client.connect();
  try {
    await client.query('BEGIN');
    const adminId = await upsertUser(client, PLATFORM_ADMIN.email, PLATFORM_ADMIN.name, true);
    await setPassword(client, adminId, await hasher.hash(seedPassword));
    for (const t of TENANTS) {
      const tenant = await client.query<{ id: string }>(
        `INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [newId(), t.slug, t.name],
      );
      const tenantId = tenant.rows[0]?.id as string;
      const people = [
        { email: `admin@${t.slug}.example`, name: `${t.name} Admin`, role: 'institution_admin' },
        ...Array.from({ length: MEMBER_COUNT }, (_, i) => ({
          email: `member${i + 1}@${t.slug}.example`,
          name: `${t.name} Member ${i + 1}`,
          role: 'member',
        })),
      ];
      for (const p of people) {
        const userId = await upsertUser(client, p.email, p.name, false);
        await setPassword(client, userId, await hasher.hash(seedPassword));
        await client.query(
          `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [newId(), tenantId, userId, p.role],
        );
      }
    }
    await client.query('COMMIT');
    console.log(
      `seeded: 1 platform admin, ${TENANTS.length} tenants x ${MEMBER_COUNT + 1} members (all with SEED_USER_PASSWORD)`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error(redactSecrets(err instanceof Error ? err.message : 'seed failed', []));
  process.exit(1);
});
