import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testOwnerPool } from './support';

let owner: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
});
afterAll(async () => {
  await owner.end();
});

// A function that turns a plan node off (enable_nestloop / enable_seqscan / ...) makes the planner charge disable_cost (1e10) for every
// statement inside, so a server WITH LLVM JIT (the official postgres:17 image, Cloud SQL) compiles each of them on every call.
// A developer machine without JIT never shows it; the first CI run did (gradebook tests: 3-10+ s instead of milliseconds, ~20 timeouts).
// This pins the rule so a new function cannot reintroduce it: planner switches go together with `jit = off` (migrations 0049, 0056).
describe('planner switches and JIT', () => {
  it('every lms function that disables a plan node also runs with jit = off', async () => {
    const { rows } = await owner.query<{ fn: string }>(
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms'
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) s WHERE s ~ '^enable_[a-z]+=off$')
          AND NOT ('jit=off' = ANY (p.proconfig))
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it('the check sees the functions it is meant to cover', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND 'jit=off' = ANY (p.proconfig) AND p.proname LIKE 'gradebook%'`,
    );
    expect(rows.map((r) => r.proname)).toContain('gradebook_compute');
  });
});
