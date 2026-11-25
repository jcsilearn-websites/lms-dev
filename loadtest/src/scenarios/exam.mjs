// 2. The exam: N learners start an exam (spread over a start window), the paper is read, answers are autosaved on a realistic cadence (one change every
//    20-40 s, in batches, with the revision counter the SPA keeps), then everybody hands in inside a short burst at the end. Learners are signed in
//    first (preparation, not measured).

import { arrivalOffsets, launchAt, paceLoop, scaled, sleep } from '../schedule.mjs';
import { Histogram } from '../stats.mjs';
import { available, measure, newRecorder, O, signInLearners } from './common.mjs';

export default {
  name: 'exam',
  describe: 'start, autosave and a submit burst of one exam',
  async run(ctx) {
    const { config, state } = ctx;
    const n = scaled(config.learners, 1, available(ctx));
    const learners = await signInLearners(ctx, n);
    const rec = newRecorder(ctx);
    measure(learners, rec);
    const lag = new Histogram(100_000);
    const examMs = config.examSeconds * 1000;
    const startSpreadMs = config.startSpreadSeconds * 1000;
    const submitSpreadMs = config.submitSpreadSeconds * 1000;
    const saveEveryMs = config.saveEverySeconds * 1000;
    ctx.log(
      `  ${learners.length} learners: start within ${startSpreadMs / 1000} s, exam ${examMs / 1000} s, autosave every ~${saveEveryMs / 1000} s, submit burst ${submitSpreadMs / 1000} s`,
    );
    const t0 = performance.now();
    const endAt = t0 + examMs;
    const base = `${O(ctx)}/items/${state.exam.itemId}`;
    let started = 0;
    let submitted = 0;
    const offsets = arrivalOffsets(learners.length, startSpreadMs / 1000, 'uniform', ctx.rng);
    await launchAt(
      offsets,
      async (i) => {
        const c = learners[i];
        const start = await c.post(`${base}/attempts`, {}, { retryBusy: 3 });
        if (start.status !== 200 && start.status !== 201) return;
        started++;
        const attemptId = start.json.attemptId;
        const paper = await c.get(`${O(ctx)}/attempts/${attemptId}`);
        if (paper.status !== 200) return;
        const questions = paper.json.questions;
        let rev = 0;
        // answers: a few questions per save, in order, wrapping around (a learner who revises)
        await paceLoop(
          async (tick) => {
            const batch = [0, 1, 2]
              .map((k) => questions[(tick * 2 + k) % questions.length])
              .filter(Boolean);
            rev++;
            await c.put(
              `${O(ctx)}/attempts/${attemptId}/answers`,
              {
                answers: batch.map((q) => ({
                  position: q.position,
                  answer: { o: [q.options[(tick + q.position) % q.options.length].id] },
                  rev,
                  at: Date.now(),
                })),
                events: [],
              },
              { retryBusy: 3 },
            );
          },
          saveEveryMs,
          { until: () => performance.now() >= endAt - 50, rng: ctx.rng, jitter: 0.25 },
        );
        // the burst: everybody hands in inside the last submit window
        const wait = endAt + ctx.rng() * submitSpreadMs - performance.now();
        if (wait > 0) await sleep(wait);
        const done = await c.post(`${O(ctx)}/attempts/${attemptId}/submit`, {}, { retryBusy: 5 });
        if (done.status === 200) submitted++;
        if (done.status === 200 && ctx.rng() < 0.3)
          await c.get(`${O(ctx)}/attempts/${attemptId}/result`);
      },
      { onLag: (ms) => lag.record(ms), onError: (e) => ctx.log(`! ${e.message}`) },
    );
    return {
      recorder: rec,
      lag: lag.snapshot(),
      notes: [`${started} of ${learners.length} exams started, ${submitted} submitted`],
    };
  },
};
