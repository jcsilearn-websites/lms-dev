import { performance } from 'node:perf_hooks';
import pg from 'pg';

// Per-statement profiler for the WORKER connection of a test (opt-in, used by imports.scale.test.ts when
// IMPORT_PROFILE=1). It wraps pg.Client.prototype.query for clients whose application_name matches, so no
// production code changes. For the statement kinds listed in `explain` it first runs
//   SAVEPOINT; EXPLAIN (ANALYZE, BUFFERS) <the statement>; ROLLBACK TO SAVEPOINT
// on the same connection (inside the open transaction, RLS context included), so the plan is that of the
// real statement on the real data, and the real statement then runs normally.

export type StatementKind =
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'batch_main'
  | 'batch_counts'
  | 'validate'
  | 'job_claim'
  | 'job_heartbeat'
  | 'job_complete'
  | 'job_fail'
  | 'other';

export interface StatementRecord {
  kind: StatementKind;
  /** client-side wall time of the round trip, ms */
  ms: number;
  /** wall-clock start, ms since profiler start */
  at: number;
}

export interface PlanRecord {
  kind: StatementKind;
  /** 1-based index among statements of this kind */
  nth: number;
  plan: string;
}

export function classify(text: string): StatementKind {
  const head = text.trimStart().slice(0, 40).toUpperCase();
  if (head.startsWith('BEGIN')) return 'begin';
  if (head.startsWith('COMMIT')) return 'commit';
  if (head.startsWith('ROLLBACK')) return 'rollback';
  if (text.includes('import_ensure_users') && text.includes('WITH job AS')) return 'batch_main';
  if (
    text.includes('WITH r AS') &&
    text.includes('dup AS') &&
    text.includes('UPDATE lms.import_rows x')
  )
    return 'validate';
  if (text.includes('UPDATE lms.import_jobs j') && text.includes('processed_rows'))
    return 'batch_counts';
  if (text.includes('job_claim')) return 'job_claim';
  if (text.includes('job_extend_lease')) return 'job_heartbeat';
  if (text.includes('job_complete')) return 'job_complete';
  if (text.includes('job_fail')) return 'job_fail';
  return 'other';
}

export function installProfiler(opts: {
  applicationName: string;
  /** kinds to EXPLAIN (ANALYZE, BUFFERS) before they run: only statements inside a transaction */
  explain: StatementKind[];
  /** explain only these occurrences (1-based) of each kind; default: all */
  explainNth?: (kind: StatementKind, nth: number) => boolean;
}) {
  const proto = pg.Client.prototype as unknown as {
    query: (this: pg.Client, ...args: unknown[]) => unknown;
  };
  const original = proto.query;
  const t0 = performance.now();
  const records: StatementRecord[] = [];
  const plans: PlanRecord[] = [];
  const seen = new Map<StatementKind, number>();

  proto.query = function (this: pg.Client, ...args: unknown[]) {
    const params = (this as unknown as { connectionParameters?: { application_name?: string } })
      .connectionParameters;
    const last = args[args.length - 1];
    if (params?.application_name !== opts.applicationName || typeof last === 'function') {
      return original.apply(this, args);
    }
    const first = args[0] as string | { text?: string; values?: unknown[] };
    const text = typeof first === 'string' ? first : (first.text ?? '');
    // drizzle passes the parameters as the second argument, the config object carries only text/name
    const values =
      (args[1] as unknown[] | undefined) ?? (typeof first === 'string' ? undefined : first.values);
    const kind = classify(text);
    const nth = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, nth);

    const run = async () => {
      if (opts.explain.includes(kind) && (opts.explainNth?.(kind, nth) ?? true)) {
        await original.call(this, 'SAVEPOINT profile_explain');
        await original.call(this, 'SET LOCAL statement_timeout = 0');
        try {
          const r = (await original.call(
            this,
            `EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF) ${text}`,
            values,
          )) as pg.QueryResult;
          plans.push({
            kind,
            nth,
            plan: r.rows.map((row) => String(row['QUERY PLAN'])).join('\n'),
          });
        } catch (err) {
          process.stdout.write(
            `PROFILE-EXPLAIN-ERROR ${kind} #${nth}: ${(err as Error).message}\n`,
          );
        } finally {
          await original.call(this, 'ROLLBACK TO SAVEPOINT profile_explain');
        }
      }
      const start = performance.now();
      try {
        return await original.apply(this, args);
      } catch (err) {
        const ms = (performance.now() - start).toFixed(0);
        const msg = String((err as Error).message).slice(-200);
        process.stdout.write(`PROFILE-ERROR kind=${kind} nth=${nth} after ${ms} ms: ${msg}\n`);
        throw err;
      } finally {
        records.push({ kind, ms: performance.now() - start, at: start - t0 });
      }
    };
    return run();
  };

  return {
    records,
    plans,
    uninstall() {
      proto.query = original;
    },
  };
}

/** Pulls the headline numbers out of an EXPLAIN ANALYZE text: execution time, triggers, big nodes. */
export function summarizePlan(plan: string): string[] {
  const out: string[] = [];
  for (const line of plan.split('\n')) {
    const exec = /^(Execution Time|Planning Time): (.*)$/.exec(line);
    if (exec) out.push(`${exec[1]}: ${exec[2]}`);
    if (/^Trigger /.test(line)) out.push(line.trim());
  }
  // the most expensive nodes by "actual time=a..b" end value (inclusive of children)
  const nodes: { ms: number; line: string }[] = [];
  for (const line of plan.split('\n')) {
    const m = /actual time=[0-9.]+\.\.([0-9.]+) rows=(\d+) loops=(\d+)/.exec(line);
    if (m) nodes.push({ ms: Number(m[1]) * Number(m[3]), line: line.trim().slice(0, 150) });
  }
  nodes.sort((a, b) => b.ms - a.ms);
  for (const n of nodes.slice(0, 8)) out.push(`  ${n.ms.toFixed(1)} ms  ${n.line}`);
  return out;
}
