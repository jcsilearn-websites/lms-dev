import type pg from 'pg';
import type { TestClient } from './client';
import { type Json, ok, uniq } from './courses-helpers';
import { type Class, base as gbBase } from './gradebook-helpers';

// Shared by the data-protection tests (step 14b).

/** every text / jsonb / inet column of every table of schema lms, searched for the tokens (owner connection: sees all colleges) */
export async function whereStored(
  owner: pg.Pool,
  tokens: string[],
): Promise<Record<string, number>> {
  const cols = (
    await owner.query(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'lms' AND c.data_type IN ('text', 'character varying', 'USER-DEFINED', 'jsonb', 'json', 'inet')
          AND c.table_name <> 'schema_migrations' ORDER BY 1, 2`,
    )
  ).rows as { table_name: string; column_name: string }[];
  const out: Record<string, number> = {};
  for (const { table_name: tbl, column_name: col } of cols) {
    const r = await owner.query(
      `SELECT count(*)::int AS n FROM lms."${tbl}" WHERE "${col}"::text ILIKE ANY ($1)`,
      [tokens.map((x) => `%${x}%`)],
    );
    if (r.rows[0].n > 0) out[`${tbl}.${col}`] = r.rows[0].n;
  }
  return out;
}

/** submit + approve a gradebook of one manual item (a locked version with one snapshot row per learner) */
export async function approveGradebook(
  e: Class,
  admin: TestClient,
  ...pids: (string | undefined)[]
): Promise<void> {
  const ic = e.instructor.client;
  const b = gbBase(e.offeringId);
  const cfg = ok(
    await ic.put(`${b}/categories`, {
      categories: [{ name: 'Tests', weight: 100, dropLowest: 0, missingPolicy: 'exclude' }],
    }),
  );
  const cat = cfg.categories[0].id as string;
  const g = ok(
    await ic.put(`${b}/items`, {
      items: [
        {
          source: 'manual',
          title: 'Test 1',
          categoryId: cat,
          points: 50,
          extraCredit: false,
          released: true,
        },
      ],
    }),
  );
  const item = (g.items as Json[]).find((i) => i.title === 'Test 1')?.id as string;
  ok(
    await ic.patch(`${b}/settings`, {
      weighted: true,
      outOf: 50,
      roundMode: 'half_up',
      roundDecimals: 0,
    }),
  );
  ok(
    await ic.put(`${b}/marks`, {
      cells: pids
        .filter((p): p is string => !!p)
        .map((p, i) => ({ itemId: item, participantId: p, points: String(40 - i * 10) })),
    }),
  );
  const scale = ok(
    await admin.post('/grade-scales', {
      name: uniq('Scale'),
      bands: [
        { minPercent: 0, label: 'RA', isPass: false },
        { minPercent: 50, label: 'C', isPass: true },
      ],
    }),
  );
  ok(await ic.patch(`${b}/settings`, { scaleId: scale.id }));
  ok(await ic.post(`${b}/submit`));
  ok(await admin.post(`${b}/approve`, { comment: 'ok' }));
}
