// The full-scale numbers of each scenario, and how a run shrinks them. `--scale` multiplies the NUMBER of simulated people, `--time-scale` multiplies the
// WINDOWS (how long a phase lasts) and `--cadence-scale` the per-person CADENCES (autosave, heartbeat, think time, bell). For a reduced run that keeps the
// arrival rates of full scale, give `--scale` and `--time-scale` the same value and leave the cadences alone. A flag such as `--learners 300` sets one number outright. The full-scale values are the ones
// of the Step 14b plan (a 1,500-learner exam, 2,000 concurrent viewers); they are what docs/load-testing.md runs against GCP.

import { scaled, scaledMs } from './schedule.mjs';

/** Full-scale people. */
export const FULL = { learners: 1500, viewers: 2000, browsers: 1000, graders: 20 };
/** Full-scale WINDOWS in seconds: how long a phase lasts. `--time-scale` shrinks them. */
export const FULL_WINDOWS = {
  waveSeconds: 300, // the morning login rush
  examSeconds: 3600, // a one-hour exam
  startSpreadSeconds: 120, // everybody starts inside two minutes
  submitSpreadSeconds: 60, // and hands in inside the last minute
  deadlineSeconds: 600, // the window before an assignment deadline
  videoRampSeconds: 300, // viewers press play over five minutes
  videoWatchSeconds: 600, // and watch ten minutes
  gradingSeconds: 900, // a grading session
  browseSeconds: 600,
};
/**
 * Full-scale CADENCES in seconds: how often ONE person does something. `--cadence-scale` shrinks them (the smoke run only; a measurement keeps them
 * at 1, because a user who autosaves 20 times as often is a different load, not a faster test).
 */
export const FULL_CADENCES = {
  saveEverySeconds: 30, // an autosave batch
  heartbeatSeconds: 30, // the player's heartbeat
  thinkSeconds: 8, // time between clicks
  bellSeconds: 60, // the notification bell's poll
};

export const OPTION_DEFS = {
  state: { type: 'string' },
  api: { type: 'string' },
  host: { type: 'string' },
  scenario: { type: 'string', default: 'all' },
  scale: { type: 'string', default: '1' },
  'time-scale': { type: 'string', default: '1' },
  'cadence-scale': { type: 'string', default: '1' },
  'learner-offset': { type: 'string', default: '0' },
  learners: { type: 'string' },
  viewers: { type: 'string' },
  browsers: { type: 'string' },
  graders: { type: 'string' },
  'file-kb': { type: 'string', default: '2048' },
  'login-rate': { type: 'string', default: '20' },
  connections: { type: 'string', default: '512' },
  'with-browsing': { type: 'string' },
  seed: { type: 'string', default: '20261125' },
  out: { type: 'string' },
  enforce: { type: 'boolean', default: false },
  'max-error-rate': { type: 'string', default: '0.01' },
};

function numberOf(name, text) {
  const x = Number(text);
  if (!Number.isFinite(x) || x <= 0) throw new Error(`--${name} must be a positive number`);
  return x;
}

function rateOf(name, text) {
  const x = Number(text);
  if (!Number.isFinite(x) || x < 0 || x > 1)
    throw new Error(`--${name} must be a number from 0 to 1`);
  return x;
}

/** Resolves the flags to one plain object (counts and durations); also the object a result file records. */
export function resolveConfig(values) {
  const scale = numberOf('scale', values.scale);
  const timeScale = numberOf('time-scale', values['time-scale']);
  const cadenceScale = numberOf('cadence-scale', values['cadence-scale']);
  const count = (flag, full) =>
    values[flag] !== undefined ? Math.round(numberOf(flag, values[flag])) : scaled(full, scale);
  const config = {
    scale,
    timeScale,
    cadenceScale,
    learners: count('learners', FULL.learners),
    viewers: count('viewers', FULL.viewers),
    browsers: count('browsers', FULL.browsers),
    graders: count('graders', FULL.graders),
    fileKb: Math.round(numberOf('file-kb', values['file-kb'])),
    loginRate: numberOf('login-rate', values['login-rate']),
    connections: Math.round(numberOf('connections', values.connections)),
    seed: Math.round(numberOf('seed', values.seed)),
    maxErrorRate: rateOf('max-error-rate', values['max-error-rate']),
    // this generator's first learner is learner (offset + 1): several machines take disjoint ranges of the seeded learners
    learnerOffset: Math.round(Number(values['learner-offset'] ?? 0)),
    withBrowsing:
      values['with-browsing'] === undefined
        ? 0
        : Math.round(numberOf('with-browsing', values['with-browsing'])),
  };
  for (const [k, seconds] of Object.entries(FULL_WINDOWS))
    config[k] = scaledMs(seconds * 1000, timeScale, 200) / 1000;
  for (const [k, seconds] of Object.entries(FULL_CADENCES))
    config[k] = scaledMs(seconds * 1000, cadenceScale, 100) / 1000;
  return config;
}
