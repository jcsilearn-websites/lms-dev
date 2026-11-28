import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deleteTenantCascade } from '../db/dev-cleanup';
import { type DemoOptions, openOwner } from './runtime';

// Removes a demo college completely: every row of it (including the histories the application itself may never delete: this is
// the owner connection of a development database), the accounts that belong to no other college, and its stored files.
// The guard of openOwner applies: never production, never an unlisted host, only a `demo-` slug.

export async function removeDemo(opts: DemoOptions): Promise<boolean> {
  const env = opts.env ?? process.env;
  const owner = await openOwner(opts);
  try {
    const found = await owner.query<{ id: string }>('SELECT id FROM lms.tenants WHERE slug = $1', [
      opts.slug,
    ]);
    const tenantId = found.rows[0]?.id;
    if (!tenantId) return false;
    await owner.query('BEGIN');
    try {
      await deleteTenantCascade(owner, tenantId);
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK').catch(() => {});
      throw err;
    }
    // storage keys are `<tenant id>/...`: only this college's folder
    rmSync(join(resolve(env.STORAGE_LOCAL_DIR ?? '.storage'), tenantId), {
      recursive: true,
      force: true,
    });
    return true;
  } finally {
    await owner.end().catch(() => {});
  }
}
