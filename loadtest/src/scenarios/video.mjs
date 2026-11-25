// 4. Concurrent video viewers: each opens a playback session, reads the master and one variant playlist (a rendition chosen with the assumed mix
//    20 / 30 / 50 % for 360p / 480p / 720p), pulls the init segment and then one segment per segment duration, and sends a progress heartbeat on the
//    cadence of the player (30 s). Like the real player it asks for a NEW playback session shortly before the old one expires (and once more when a segment
//    is refused), so a short token lifetime costs session requests, never a wave of refusals. On the local provider the API serves the segments; with a
//    CDN the segment requests go to the CDN and this scenario measures what the CDN-less path costs. With --cadence-scale below 1 the clock runs faster,
//    so heartbeats claim more than real time: the server counts those as `suspicious` (never an error).

import { randomUUID } from 'node:crypto';
import { parseMaster, parseMedia, pickWeighted } from '../hls.mjs';
import { arrivalOffsets, launchAt, scaled, sleep } from '../schedule.mjs';
import { Histogram } from '../stats.mjs';
import { available, measure, newRecorder, O, signInLearners } from './common.mjs';

const MIX = [0.2, 0.3, 0.5];
/** The player renews its session this long before it expires. */
const RENEW_MARGIN_MS = 3000;

export default {
  name: 'video',
  describe: 'concurrent viewers: playback session, playlists, segments and heartbeats',
  async run(ctx) {
    const { config, state } = ctx;
    if (!state.video)
      return {
        skipped:
          'the college has no video (seed it with ffmpeg on the PATH and the worker running)',
      };
    const n = scaled(config.viewers, 1, available(ctx));
    const viewers = await signInLearners(ctx, n);
    const rec = newRecorder(ctx);
    measure(viewers, rec);
    const lag = new Histogram(100_000);
    const item = `${O(ctx)}/items/${state.video.itemId}`;
    const rampSeconds = config.videoRampSeconds;
    const watchMs = config.videoWatchSeconds * 1000;
    ctx.log(
      `  ${viewers.length} viewers, ramp ${rampSeconds} s, each watches ${config.videoWatchSeconds} s, heartbeat every ${config.heartbeatSeconds} s`,
    );
    let playing = 0;
    let segments = 0;
    let renewals = 0;
    const offsets = arrivalOffsets(viewers.length, rampSeconds, 'uniform', ctx.rng);
    await launchAt(
      offsets,
      async (i) => {
        const c = viewers[i];
        const rendition = pickWeighted(MIX, ctx.rng());

        /** A playback session, its master and the variant playlist of the viewer's rendition. null when any step is refused. */
        const openSession = async () => {
          const session = await c.post(`${item}/playback`, {}, { retryBusy: 3 });
          if (session.status !== 200 && session.status !== 201) return null;
          const manifest = new URL(session.json.manifestUrl, ctx.target.origin);
          const master = await c.call('GET', manifest.pathname + manifest.search, {
            absolute: true,
            label: 'GET master.m3u8',
          });
          if (master.status !== 200) return null;
          const variants = parseMaster(master.text).sort((a, b) => a.height - b.height);
          if (variants.length === 0) return null;
          const variantUrl = new URL(
            variants[Math.min(variants.length - 1, rendition)].uri,
            manifest,
          );
          const media = await c.call('GET', variantUrl.pathname + variantUrl.search, {
            absolute: true,
            label: 'GET variant playlist',
          });
          if (media.status !== 200) return null;
          return {
            variantUrl,
            plan: parseMedia(media.text),
            expiresAt: Date.parse(session.json.expiresAt),
          };
        };
        const fetchPart = (s, rel, label) => {
          const u = new URL(rel, s.variantUrl);
          return c.call('GET', u.pathname + u.search, { absolute: true, binary: true, label });
        };

        let s = await openSession();
        if (!s) return;
        if (s.plan.init) await fetchPart(s, s.plan.init, 'GET init.mp4');
        playing++;
        const streamId = randomUUID();
        const started = performance.now();
        let seq = 0;
        let played = 0;
        let sinceBeat = 0;
        let lastBeatAt = started;
        let lastBeatPos = 0;
        const beat = async () => {
          seq++;
          const to = Math.min(played, state.video.seconds);
          if (to <= lastBeatPos) return;
          await c.post(
            `${O(ctx)}/items/${state.video.itemId}/progress/heartbeat`,
            {
              videoId: state.video.videoId,
              streamId,
              seq,
              ranges: [[lastBeatPos, to]],
              position: to,
              rate: 1,
            },
            { retryBusy: 1 },
          );
          lastBeatPos = to;
          lastBeatAt = performance.now();
          sinceBeat = 0;
        };
        for (let k = 0; k < s.plan.segments.length; k++) {
          if (performance.now() - started > watchMs) break;
          const t0 = performance.now();
          // renew BEFORE the token runs out, as the player does (the server's clock and ours may differ by a little: the margin covers it)
          if (Number.isFinite(s.expiresAt) && Date.now() + RENEW_MARGIN_MS >= s.expiresAt) {
            const renewed = await openSession();
            if (renewed) {
              s = renewed;
              renewals++;
            }
          }
          const seg = s.plan.segments[k];
          let r = await fetchPart(s, seg.uri, 'GET segment');
          if (r.status === 403) {
            // refused anyway (a clock skew, a token that expired in flight): one new session and one retry, like the player
            const renewed = await openSession();
            if (renewed) {
              s = renewed;
              renewals++;
              r = await fetchPart(s, s.plan.segments[k].uri, 'GET segment');
            }
          }
          if (r.status === 200) segments++;
          played += seg.seconds;
          sinceBeat += seg.seconds;
          if (performance.now() - lastBeatAt >= config.heartbeatSeconds * 1000) await beat();
          // real time: the next segment is wanted when this one has played (the player keeps a small buffer, ignored here)
          await sleep(seg.seconds * 1000 * config.cadenceScale - (performance.now() - t0));
        }
        if (sinceBeat > 0) await beat();
      },
      { onLag: (ms) => lag.record(ms), onError: (e) => ctx.log(`! ${e.message}`) },
    );
    return {
      recorder: rec,
      lag: lag.snapshot(),
      notes: [
        `${playing} of ${viewers.length} viewers started playing, ${segments} segments fetched, ${renewals} playback sessions renewed`,
      ],
    };
  },
};
