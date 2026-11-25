// 5. Instructors grading: G instructors work through the hand-in queue of the assignment (each starting at its own place), open a learner, think for a
//    few seconds, save a grade, and now and then look at the grading summary and the gradebook grid. When the queue holds too few hand-ins the setup
//    makes text hand-ins first (as the learners; not measured).

import { randomUUID } from 'node:crypto';
import { launchAt, mapLimit, scaled, sleep } from '../schedule.mjs';
import { Histogram } from '../stats.mjs';
import { available, measure, newRecorder, O, signInLearners, signInTeachers } from './common.mjs';

export default {
  name: 'grading',
  describe:
    'instructors page through the queue and grade, with the grading summary and the gradebook grid',
  async run(ctx) {
    const { config, state } = ctx;
    const G = Math.min(config.graders, state.instructors);
    const teachers = await signInTeachers(ctx, G);
    const A = `${O(ctx)}/items/${state.assignment.itemId}/assignment`;

    // setup: enough hand-ins to grade (text only: cheap)
    const need = scaled(config.learners, 1, available(ctx));
    const summary = await teachers[0].get(`${A}/grading/summary`, { record: false });
    const have =
      Number(summary.json?.submitted ?? summary.json?.counts?.submitted ?? 0) +
      Number(summary.json?.graded ?? 0);
    if (have < need) {
      const missing = need - have;
      ctx.log(`  setup: ${missing} text hand-ins first (the queue held ${have})`);
      const learners = await signInLearners(ctx, Math.min(available(ctx), need));
      await mapLimit(learners.slice(0, missing), 16, (c, i) =>
        c.post(
          `${A}/submissions`,
          { requestKey: randomUUID(), fileIds: [], text: `Work of learner ${i + 1}` },
          { record: false, retryBusy: 5 },
        ),
      );
    }

    const rec = newRecorder(ctx);
    measure(teachers, rec);
    const lag = new Histogram(100_000);
    const stopAt = performance.now() + config.gradingSeconds * 1000;
    let graded = 0;
    ctx.log(
      `  ${G} instructors grading for ${config.gradingSeconds} s, think time ~${config.thinkSeconds} s`,
    );
    await launchAt(
      Array.from({ length: G }, (_, k) => k * 250),
      async (k) => {
        const t = teachers[k];
        let after;
        while (performance.now() < stopAt) {
          const q = await t.get(
            `${A}/grading/queue?limit=25${after ? `&after=${encodeURIComponent(after)}` : ''}`,
          );
          if (q.status !== 200) return;
          if (q.json.items.length === 0) {
            after = undefined;
            await sleep(1000);
            continue;
          }
          // instructor k starts at row k of the page, so they do not all open the same learner
          const rows = [
            ...q.json.items.slice(k % q.json.items.length),
            ...q.json.items.slice(0, k % q.json.items.length),
          ];
          for (const row of rows) {
            if (performance.now() >= stopAt) return;
            const learner = await t.get(`${A}/grading/learners/${row.learnerKey}`, {
              label: 'GET /grading/learners/:key',
            });
            if (learner.status !== 200 || learner.json.submissions.length === 0) continue;
            await sleep(config.thinkSeconds * 1000 * (0.5 + ctx.rng()));
            const grade = await t.put(
              `${A}/grading/learners/${row.learnerKey}/grade`,
              {
                submissionId: learner.json.submissions[0].id,
                rawScore: Math.round(ctx.rng() * learner.json.maxPoints),
                feedback: null,
              },
              { label: 'PUT /grading/learners/:key/grade', retryBusy: 2 },
            );
            if (grade.status === 200) graded++;
            if (ctx.rng() < 0.1) await t.get(`${A}/grading/summary`);
            if (ctx.rng() < 0.03) await t.get(`${O(ctx)}/gradebook/grid`);
          }
          after = q.json.nextCursor ?? undefined;
        }
      },
      { onLag: (ms) => lag.record(ms), onError: (e) => ctx.log(`! ${e.message}`) },
    );
    return {
      recorder: rec,
      lag: lag.snapshot(),
      notes: [`${graded} grades saved by ${G} instructors`],
    };
  },
};
