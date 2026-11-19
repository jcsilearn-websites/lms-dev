import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { connectionConfig } from '../src/db/connection';
import { getTestDatabases } from './support';

// Migration 0058: the application role starts every session in UTC with JIT off, wherever the server's own defaults point.
// The connection is FRESH and sends its own `options`, which replaces the PGOPTIONS of the time-sweep runs
// (`PGOPTIONS="-c timezone=Pacific/Pago_Pago"` would otherwise win over the role setting and hide it).
describe('lms_app session defaults', () => {
  it('a fresh lms_app connection has timezone UTC and jit off', async () => {
    const dbs = getTestDatabases();
    const client = new pg.Client({
      ...connectionConfig(dbs.appUrl, dbs.ssl, dbs.sslCa),
      options: '-c application_name=app-role-defaults',
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string; setting: string; source: string }>(
        `SELECT name, setting, source FROM pg_settings WHERE lower(name) IN ('timezone', 'jit') ORDER BY lower(name)`,
      );
      expect(rows.map((r) => [r.name.toLowerCase(), r.setting, r.source])).toEqual([
        ['jit', 'off', 'user'],
        ['timezone', 'UTC', 'user'],
      ]);
      // the zone really governs a cast: 2026-11-18 18:30 UTC is already 19 Nov in Kolkata, but the plain date is the UTC one
      const d = await client.query<{ d: string }>(
        `SELECT ('2026-11-18T18:30:00Z'::timestamptz)::date::text AS d`,
      );
      expect(d.rows[0]?.d).toBe('2026-11-18');
    } finally {
      await client.end();
    }
  });
});
