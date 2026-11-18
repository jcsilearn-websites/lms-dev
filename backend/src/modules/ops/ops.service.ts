import type { Telemetry } from '../../core/telemetry';
import type { Database } from '../../db/client';
import type { OpsMetricRow, OpsRepository } from './ops.repository';

const GAUGES: Record<string, { name: string; label?: string; description: string }> = {
  job_queue_depth: {
    name: 'lms_job_queue_depth',
    label: 'queue',
    description: 'Due jobs waiting, per queue',
  },
  job_queue_oldest_age_seconds: {
    name: 'lms_job_queue_oldest_age_seconds',
    label: 'queue',
    description: 'Age of the oldest due job, per queue',
  },
  job_running: { name: 'lms_jobs_running', label: 'queue', description: 'Jobs running, per queue' },
  job_dead: {
    name: 'lms_jobs_dead',
    label: 'queue',
    description: 'Dead-lettered jobs kept, per queue',
  },
  email_outbox_backlog: {
    name: 'lms_email_outbox_backlog',
    label: 'status',
    description: 'Due emails waiting (queued) or in flight (sending)',
  },
  email_outbox_oldest_age_seconds: {
    name: 'lms_email_outbox_oldest_age_seconds',
    description: 'Age of the oldest due queued email',
  },
  email_outbox_dead: {
    name: 'lms_email_outbox_dead',
    description: 'Emails that will never be sent (dead)',
  },
  rollup_lag_seconds: {
    name: 'lms_rollup_lag_seconds',
    description: 'How far behind the oldest college learner rollup is',
  },
  video_backlog: {
    name: 'lms_video_backlog',
    label: 'status',
    description: 'Videos waiting for or in the transcoder',
  },
  video_oldest_age_seconds: {
    name: 'lms_video_oldest_age_seconds',
    description: 'Age of the oldest video in processing',
  },
};

export interface OpsService {
  /** The gauge rows, read at most once per `cacheMs` (a scrape storm costs one statement). */
  rows(): Promise<OpsMetricRow[]>;
  /** Registers the database-state gauges and the pool gauge on a telemetry instance. */
  registerGauges(telemetry: Telemetry): void;
}

export function createOpsService(deps: {
  db: Database;
  opsRepo: OpsRepository;
  cacheMs?: number;
  now?: () => number;
}): OpsService {
  const { db, opsRepo } = deps;
  const cacheMs = deps.cacheMs ?? 5000;
  const now = deps.now ?? Date.now;
  let cached: { at: number; rows: OpsMetricRow[] } | null = null;
  let loading: Promise<OpsMetricRow[]> | null = null;

  const rows = async (): Promise<OpsMetricRow[]> => {
    if (cached && now() - cached.at < cacheMs) return cached.rows;
    loading ??= db
      .withoutTenant((tx) => opsRepo.metrics(tx))
      .then((r) => {
        cached = { at: now(), rows: r };
        return r;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  return {
    rows,
    registerGauges(telemetry) {
      const meter = telemetry.meter;
      const pool = meter.createObservableGauge('lms_db_pool_connections', {
        description: 'Database pool connections by state (total, idle, waiting callers)',
      });
      pool.addCallback((result) => {
        const s = db.stats();
        result.observe(s.total, { state: 'total' });
        result.observe(s.idle, { state: 'idle' });
        result.observe(s.waiting, { state: 'waiting' });
      });
      const gauges = new Map(
        Object.entries(GAUGES).map(([metric, g]) => [
          metric,
          meter.createObservableGauge(g.name, { description: g.description }),
        ]),
      );
      // one batch callback: the gauges share ONE read of the database
      meter.addBatchObservableCallback(
        async (result) => {
          let data: OpsMetricRow[];
          try {
            data = await rows();
          } catch {
            return; // the database is unreachable: no sample is better than a wrong one (readiness reports it)
          }
          for (const r of data) {
            const g = GAUGES[r.metric];
            const instrument = gauges.get(r.metric);
            if (!g || !instrument) continue;
            result.observe(instrument, r.value, g.label ? { [g.label]: r.label } : {});
          }
        },
        [...gauges.values()],
      );
    },
  };
}
