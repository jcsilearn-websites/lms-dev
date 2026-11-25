// What every scenario shares: reading the seed state, signing the simulated users in (the PREPARATION phase, kept out of the results), and the
// bookkeeping of a timed phase (schedule lag, end-to-end timings).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient } from '../client.mjs';
import { mapLimit, ratePacer } from '../schedule.mjs';
import { Recorder } from '../stats.mjs';

export const STATE_DIR = join(import.meta.dirname, '..', '..', '.state');

export function loadState(slugOrPath) {
  const file = slugOrPath.endsWith('.json') ? slugOrPath : join(STATE_DIR, `${slugOrPath}.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const learnerEmail = (state, i) => `learner${i}@${state.slug}.test`;
export const teacherEmail = (state, k) => `teacher${k}@${state.slug}.test`;

/**
 * Signs in learners 1..count (at most `loginRate` a second, `lanes` at once) and returns the clients that got a session. The sign-in is the POINT of
 * the login-wave scenario and only preparation for the others: here it is recorded in `ctx.prep`, never in the results.
 */
export async function signInLearners(ctx, count, { from = 1 + ctx.config.learnerOffset } = {}) {
  const take = ratePacer(ctx.config.loginRate);
  const indices = Array.from({ length: count }, (_, i) => from + i);
  let failed = 0;
  const clients = await mapLimit(indices, 16, async (i) => {
    await take();
    const c = new ApiClient({ target: ctx.target, recorder: ctx.prep, name: `learner${i}` });
    if (await c.login(learnerEmail(ctx.state, i), ctx.state.password, { record: true })) return c;
    failed++;
    return null;
  });
  if (failed)
    ctx.log(
      `! ${failed} of ${count} sign-ins failed during preparation (rate limit? raise RATE_LIMIT_LOGIN_PER_IP / lower --login-rate)`,
    );
  return clients.filter(Boolean);
}

export async function signInTeachers(ctx, count) {
  const out = [];
  for (let k = 1; k <= count; k++) {
    const c = new ApiClient({ target: ctx.target, recorder: ctx.prep, name: `teacher${k}` });
    if (!(await c.login(teacherEmail(ctx.state, k), ctx.state.password)))
      throw new Error(`teacher${k} could not sign in`);
    out.push(c);
  }
  return out;
}

/**
 * Switches signed-in clients from the preparation recorder to the recorder of the measured phase: from here on every call they make is a result.
 * (Forgetting this leaves the results empty and the run looking perfect: the smoke run asserts that each scenario recorded its routes.)
 */
/** How many seeded learners this generator may use (those after its offset). */
export const available = (ctx) => Math.max(0, ctx.state.learners - ctx.config.learnerOffset);

export function measure(clients, recorder) {
  for (const c of clients) c.recorder = recorder;
  return clients;
}

export function newRecorder(ctx) {
  return new Recorder({ seed: ctx.config.seed });
}

export const O = (ctx) => `/api/offerings/${ctx.state.offeringId}`;

/** A small PDF-looking file of about `kb` kilobytes: the type is checked against the bytes (magic number), the rest is filler. */
export function pdfBytes(label, kb) {
  const head = `%PDF-1.4\n1 0 obj\n<<>>\nendobj\n% ${label}\n`;
  const filler = '% filler filler filler filler filler filler filler filler filler\n';
  const body = filler.repeat(Math.max(1, Math.ceil((kb * 1024 - head.length) / filler.length)));
  return Buffer.from(`${head}${body}trailer\n<<>>\n%%EOF\n`);
}
