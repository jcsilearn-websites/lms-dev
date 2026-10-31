import type pg from 'pg';

// Owner-connection helpers for DEVELOPMENT databases only (the dev-clean CLI and the benchmark).
// They delete rows the application role is not allowed to delete, so they must never be reachable
// from app code: nothing under src/modules or src/app imports this file.

/**
 * Removes a tenant and everything that belongs to it, including members who belong to no other
 * tenant (and are not platform admins). Runs inside the caller's transaction.
 */
export async function deleteTenantCascade(client: pg.Client, tenantId: string): Promise<void> {
  // children before parents: nothing that history depends on is cascade-deleted (ON DELETE RESTRICT)
  for (const table of [
    'item_progress',
    'content_items',
    'content_modules',
    'video_captions',
    'video_assets',
    'course_participants',
    'course_sync_pending',
    'offering_sections',
    'course_offerings',
    'courses',
    'files',
    'import_rows',
    'import_jobs',
    'jobs',
    'member_profiles',
    'sections',
    'batches',
    'programs',
    'departments',
    'terms',
    'academic_years',
  ]) {
    await client.query(`DELETE FROM lms.${table} WHERE tenant_id = $1`, [tenantId]);
  }
  // audit rows first: audit_log.actor_user_id has no ON DELETE action
  await client.query('DELETE FROM lms.audit_log WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM lms.auth_tokens WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM lms.sessions WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM lms.tenant_settings WHERE tenant_id = $1', [tenantId]);
  const members = await client.query<{ user_id: string }>(
    'SELECT user_id FROM lms.tenant_memberships WHERE tenant_id = $1',
    [tenantId],
  );
  await client.query('DELETE FROM lms.tenant_memberships WHERE tenant_id = $1', [tenantId]);
  const ids = members.rows.map((r) => r.user_id);
  if (ids.length > 0) {
    await client.query(
      `DELETE FROM lms.users u
       WHERE u.id = ANY($1) AND NOT u.is_platform_admin
         AND NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.user_id = u.id)`,
      [ids],
    );
  }
  await client.query('DELETE FROM lms.tenants WHERE id = $1', [tenantId]);
}

export interface CleanResult {
  benchTenants: number;
  sessions: number;
  tokens: number;
  tenantAudit: number;
  platformAudit: number;
}

/** Slugs the seed creates: the sessions and auth audit noise of local use pile up in these. */
export const SEED_TENANT_SLUGS = ['alpha-college', 'beta-institute'];

/** Removes leftover benchmark tenants and the sessions / auth audit noise of the seeded tenants. */
export async function cleanDevNoise(client: pg.Client): Promise<CleanResult> {
  const result: CleanResult = {
    benchTenants: 0,
    sessions: 0,
    tokens: 0,
    tenantAudit: 0,
    platformAudit: 0,
  };
  await client.query('BEGIN');
  try {
    const bench = await client.query<{ id: string }>(
      "SELECT id FROM lms.tenants WHERE slug LIKE 'bench-%'",
    );
    for (const row of bench.rows) await deleteTenantCascade(client, row.id);
    result.benchTenants = bench.rowCount ?? 0;

    const seed = await client.query<{ id: string }>(
      'SELECT id FROM lms.tenants WHERE slug = ANY($1)',
      [SEED_TENANT_SLUGS],
    );
    const seedIds = seed.rows.map((r) => r.id);
    // sessions of seeded tenants and of platform admins (tenant-less sessions)
    result.sessions =
      (
        await client.query(
          'DELETE FROM lms.sessions WHERE tenant_id = ANY($1) OR tenant_id IS NULL',
          [seedIds],
        )
      ).rowCount ?? 0;
    result.tokens =
      (
        await client.query(
          'DELETE FROM lms.auth_tokens WHERE tenant_id = ANY($1) OR tenant_id IS NULL',
          [seedIds],
        )
      ).rowCount ?? 0;
    result.tenantAudit =
      (
        await client.query(
          "DELETE FROM lms.audit_log WHERE tenant_id = ANY($1) AND action LIKE 'auth.%'",
          [seedIds],
        )
      ).rowCount ?? 0;
    result.platformAudit =
      (await client.query("DELETE FROM lms.platform_audit_log WHERE action LIKE 'auth.%'"))
        .rowCount ?? 0;
    // seeded accounts: forget failed attempts / locks left by manual testing
    await client.query('UPDATE lms.user_credentials SET failed_attempts = 0, locked_until = NULL');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return result;
}
