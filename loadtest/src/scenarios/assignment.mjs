// 3. The assignment deadline burst: the instructor sets a due date a few minutes ahead, and N learners hand in with an arrival curve that grows
//    towards the deadline (most arrive in the last minute): open the page, request an upload, PUT the file to the signed URL, confirm it, hand in.
//    A few per cent arrive after the due date (late work is allowed). Every call is idempotent (`requestKey`), so a retry is one version.

import { randomUUID } from 'node:crypto';
import { arrivalOffsets, launchAt, scaled } from '../schedule.mjs';
import { Histogram } from '../stats.mjs';
import {
  available,
  measure,
  newRecorder,
  O,
  pdfBytes,
  signInLearners,
  signInTeachers,
} from './common.mjs';

export default {
  name: 'assignment',
  describe: 'the hand-in burst before a deadline (file upload, confirm, submit)',
  async run(ctx) {
    const { config, state } = ctx;
    const n = scaled(config.learners, 1, available(ctx));
    const [teach] = await signInTeachers(ctx, 1);
    const learners = await signInLearners(ctx, n);
    const rec = newRecorder(ctx);
    measure(learners, rec);
    const lag = new Histogram(100_000);
    const A = `${O(ctx)}/items/${state.assignment.itemId}/assignment`;
    const windowSeconds = config.deadlineSeconds;
    // the due date is the end of the window; the last learners arrive a little after it
    const dueAt = new Date(Date.now() + windowSeconds * 1000 + 3000);
    const set = await teach.put(A, { dueAt: dueAt.toISOString() }, { record: false });
    if (set.status !== 200)
      throw new Error(`could not set the due date: ${set.status} ${set.text}`);
    ctx.log(
      `  ${learners.length} learners, due in ${windowSeconds} s, files of ${config.fileKb} KB`,
    );
    const offsets = arrivalOffsets(learners.length, windowSeconds + 3, 'deadline', ctx.rng);
    let submitted = 0;
    let late = 0;
    await launchAt(
      offsets,
      async (i, planned) => {
        const c = learners[i];
        await c.get(`${A}/me`);
        const bytes = pdfBytes(`work of learner ${i + 1}`, config.fileKb);
        const ask = await c.post(
          `${A}/files`,
          { name: 'my-work.pdf', size: bytes.length },
          { retryBusy: 5 },
        );
        if (ask.status !== 200 && ask.status !== 201) return;
        const up = ask.json.upload;
        const put = await c.call('PUT', up.url, {
          body: bytes,
          headers: { ...up.headers, 'content-length': String(bytes.length) },
          label: 'PUT (signed upload URL)',
          absolute: up.url.startsWith('/') || up.url.startsWith('http'),
          retryBusy: 3,
        });
        if (put.status < 200 || put.status >= 300) return;
        const confirmed = await c.post(
          `${A}/files/${ask.json.fileId}/confirm`,
          {},
          { retryBusy: 5 },
        );
        if (confirmed.status !== 200 && confirmed.status !== 201) return;
        const hand = await c.post(
          `${A}/submissions`,
          {
            requestKey: randomUUID(),
            fileIds: [ask.json.fileId],
            text: `Notes of learner ${i + 1}.`,
          },
          { retryBusy: 8 },
        );
        if (hand.status === 200 || hand.status === 201) {
          submitted++;
          if (planned > windowSeconds * 1000) late++;
        }
      },
      { onLag: (ms) => lag.record(ms), onError: (e) => ctx.log(`! ${e.message}`) },
    );
    return {
      recorder: rec,
      lag: lag.snapshot(),
      notes: [`${submitted} of ${learners.length} handed in (${late} planned after the due date)`],
    };
  },
};
