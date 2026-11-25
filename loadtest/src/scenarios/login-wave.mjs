// 1. The morning login wave: N learners sign in during a rush (a triangular arrival curve that peaks at 30 % of the window) and open the home page the
//    way the SPA does: /auth/me, the learner dashboard, my courses and the bell. argon2 on the server's threads is the expected limit.

import { ApiClient } from '../client.mjs';
import { arrivalOffsets, launchAt, scaled } from '../schedule.mjs';
import { Histogram } from '../stats.mjs';
import { available, learnerEmail, newRecorder } from './common.mjs';

export default {
  name: 'login-wave',
  describe: 'learners sign in in a rush and open the home page',
  async run(ctx) {
    const { config, state } = ctx;
    const n = Math.min(available(ctx), scaled(config.learners, 1));
    const windowSeconds = config.waveSeconds;
    const rec = newRecorder(ctx);
    const lag = new Histogram(100_000);
    const offsets = arrivalOffsets(n, windowSeconds, 'peak', ctx.rng);
    ctx.log(`  ${n} learners over ${Math.round(windowSeconds)} s (peak at 30 %)`);
    let signedIn = 0;
    await launchAt(
      offsets,
      async (i) => {
        const c = new ApiClient({ target: ctx.target, recorder: rec, name: `learner${i + 1}` });
        if (
          !(await c.login(learnerEmail(state, i + 1 + config.learnerOffset), state.password, {
            retryBusy: 3,
          }))
        )
          return;
        signedIn++;
        await c.get('/api/auth/me');
        await Promise.all([
          c.get('/api/me/dashboard'),
          c.get('/api/me/courses'),
          c.get('/api/notifications/unread-count'),
        ]);
      },
      { onLag: (ms) => lag.record(ms), onError: (e) => ctx.log(`! ${e.message}`) },
    );
    return {
      recorder: rec,
      lag: lag.snapshot(),
      notes: [`${signedIn} of ${n} learners signed in`],
      ignoreLabels: [],
    };
  },
};
