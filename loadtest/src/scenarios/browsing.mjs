// 6. General browsing: U learners, signed in, move around for a while with think time between clicks: the home dashboard, my courses, the course outline,
//    a reading, my progress, and the bell (polled on its own timer, as the SPA does while the tab is visible). Each click is a weighted choice.

import { launchAt, paceLoop, scaled, sleep } from '../schedule.mjs';
import { Histogram } from '../stats.mjs';
import { available, measure, newRecorder, O, signInLearners } from './common.mjs';

/** The click whose weight band holds `x` (0 <= x < total weight). */
function pickClick(clicks, x) {
  let left = x;
  for (const click of clicks) {
    left -= click[0];
    if (left < 0) return click;
  }
  return clicks[0];
}

export default {
  name: 'browsing',
  describe: 'a mix of reads: dashboard, courses, outline, readings, progress and the bell',
  async run(ctx) {
    const { config, state } = ctx;
    const n = scaled(config.browsers, 1, available(ctx));
    const users = await signInLearners(ctx, n);
    const rec = newRecorder(ctx);
    measure(users, rec);
    const lag = new Histogram(100_000);
    const stopAt = performance.now() + config.browseSeconds * 1000;
    const clicks = [
      [10, (c) => c.get('/api/me/dashboard')],
      [15, (c) => c.get('/api/me/courses')],
      [25, (c) => c.get(`${O(ctx)}/outline`)],
      [25, (c, item) => c.get(`${O(ctx)}/items/${item}`)],
      [10, (c) => c.get('/api/me/progress')],
      [10, (c, item) => c.post(`${O(ctx)}/items/${item}/progress/viewed`, {})],
      [5, (c) => c.get(`${O(ctx)}/progress`)],
    ];
    const total = clicks.reduce((a, [w]) => a + w, 0);
    ctx.log(
      `  ${users.length} users browsing for ${config.browseSeconds} s, think time ~${config.thinkSeconds} s, bell every ${config.bellSeconds} s`,
    );
    let pages = 0;
    await launchAt(
      users.map((_, i) => (i / users.length) * config.thinkSeconds * 1000),
      async (i) => {
        const c = users[i];
        const bell = paceLoop(
          () => c.get('/api/notifications/unread-count'),
          config.bellSeconds * 1000,
          { until: () => performance.now() >= stopAt, rng: ctx.rng, jitter: 0.1 },
        );
        while (performance.now() < stopAt) {
          const pick = pickClick(clicks, ctx.rng() * total);
          const item = state.textItemIds[Math.floor(ctx.rng() * state.textItemIds.length)];
          await pick[1](c, item);
          pages++;
          await sleep(config.thinkSeconds * 1000 * (0.5 + ctx.rng()));
        }
        await bell;
      },
      { onLag: (ms) => lag.record(ms), onError: (e) => ctx.log(`! ${e.message}`) },
    );
    return {
      recorder: rec,
      lag: lag.snapshot(),
      notes: [`${pages} page views by ${users.length} users`],
    };
  },
};
