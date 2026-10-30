# Video cost model

What a viewing hour of a lecture costs in bytes, measured, and the formula to turn that into a monthly bill once a provider
quotes its prices. **No prices are written here**: the blank fields in section 5 are for the quotes of the providers being
compared (Google Cloud CDN, Bunny, Cloudflare Stream, Mux).

Produced by `pnpm --filter @lms/backend run bench:video` (see `backend/bench/video-bench.ts`) on 2026-10-30: FFmpeg
`n8.1.3-9-g29e619e767` (the pinned build of [ADR 0015](adr/0015-video.md)), 4 x Intel Core i3-1005G1 @ 1.20 GHz (2 cores, 8 GB),
Windows, `-preset veryfast`, H.264 + AAC, **fragmented-MP4 segments of 6 s**, three renditions in one run. Sources: two
synthetic 5-minute 1280x720, 25 fps clips made with ffmpeg (no copyrighted material):

| sample           | what it stands for                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **lecture-like** | slides: a white page, a title bar and lines of "text" that change every 20 s, a small moving region (an instructor window or a pointer), pink noise as the sound. Mostly static: close to the **cheapest** realistic lecture. |
| **high-motion**  | a moving test pattern with constant noise and a colour shift. Hits the bit-rate cap of every rendition: the **ceiling** of what the ladder can cost.                                                                          |

**A real lecture lies between the two**, and where depends on the content (a talking head and a whiteboard cost much more than
clean slides; screen recordings of code sit near the lecture-like end). Before a contract is signed, re-run the bench on a
few real recordings of the college and replace the two rows below.

## 1. Size per hour of viewing, per rendition (fMP4)

Everything a viewer downloads for that rendition: the init segment, every media segment (video and audio) and the playlist.
GB are decimal (1 GB = 10^9 bytes).

| rendition | picture  |  video cap |     | lecture-like: average | **GB / viewing hour** |     | high-motion: average | **GB / viewing hour** |
| --------- | -------- | ---------: | --- | --------------------: | --------------------: | --- | -------------------: | --------------------: |
| 360p      | 640x360  |   400 kbps |     |               73 kbps |             **0.033** |     |             469 kbps |             **0.211** |
| 480p      | 852x480  |   700 kbps |     |              106 kbps |             **0.048** |     |             802 kbps |             **0.361** |
| 720p      | 1280x720 | 1,300 kbps |     |              109 kbps |             **0.049** |     |           1,403 kbps |             **0.631** |

Why the spread: the encoder is constant-quality (CRF 23) with a **cap** (`maxrate` 400 / 700 / 1,300 kbps, plus 64 / 96 / 96 kbps of
audio): clean slides need a fraction of the cap, noisy motion needs all of it. So **the cap is also the worst case**:
`GB per hour <= (cap + audio) x 3600 / 8 / 10^9`, i.e. at most 0.21 / 0.36 / 0.63 GB per viewing hour.

## 2. fMP4 against MPEG-TS segments (lecture-like sample, identical encoder settings)

| rendition | fMP4 GB/h | MPEG-TS GB/h | TS is larger by |
| --------- | --------: | -----------: | --------------: |
| 360p      |     0.033 |        0.050 |          50.7 % |
| 480p      |     0.048 |        0.064 |          34.4 % |
| 720p      |     0.049 |        0.064 |          30.9 % |

MPEG-TS wraps the stream in 188-byte packets with a header on each, a fixed cost that matters most when the video itself is
small (a lecture). It was measured once, on the lecture-like sample only; on content that fills the cap the relative
difference should be smaller (the fixed cost is spread over more video) but that was not measured. fMP4 is what the product
produces.

## 3. Transcoding on this machine (local provider, development and CI only)

| sample                    | source | transcode (3 renditions, 1 run) |          speed | per hour of video |
| ------------------------- | -----: | ------------------------------: | -------------: | ----------------: |
| lecture-like              |  300 s |                          77.1 s | 3.9x real time |      about 15 min |
| lecture-like, TS segments |  300 s |                          70.0 s | 4.3x real time |      about 14 min |
| high-motion               |  300 s |                         202.7 s | 1.5x real time |      about 40 min |

So a 3-hour lecture takes about 46 minutes (clean slides) to 2 hours (worst case) on this 2-core laptop, one video at a time
(`JOB_CONCURRENCY=video:1`). The local provider is **not** meant for production; this is what the managed providers replace, and
their price per transcoded minute is one of the blanks below. Playback-session endpoint
(`POST /api/offerings/:id/items/:itemId/playback`, 10 connections, 8 s, local database): 193-236 requests per second,
**p50 40-49 ms, p99 69-93 ms**, 4 database round trips per request.

## 4. The formula

```
monthly_egress_GB  =  students  x  hours_watched_per_student_per_month  x  GB_per_hour
GB_per_hour        =  sum over renditions of ( share_of_viewing_time_at_that_rendition  x  GB_per_hour_of_that_rendition )
monthly_cost       =  monthly_egress_GB x egress_price_per_GB  +  stored_GB x storage_price_per_GB_month  +  transcoded_minutes x price_per_minute  (+ fixed fees)
stored_GB          =  hours_of_lectures_stored  x  ( sum of the three renditions' GB_per_hour  +  the original while it is kept )
```

The **rendition mix** is an assumption until real player data exists (Step 8 will provide it). The player starts low and
climbs (`Auto`); phones on mobile data stay at 360p / 480p, laptops on a campus network reach 720p. Three starting points:

| mix of viewing time                        | 360p | 480p | 720p | GB / hour, lecture-like | GB / hour, high-motion |
| ------------------------------------------ | ---: | ---: | ---: | ----------------------: | ---------------------: |
| mostly phones                              | 60 % | 30 % | 10 % |                   0.039 |                  0.298 |
| balanced (our assumption for the examples) | 40 % | 40 % | 20 % |                   0.042 |                  0.355 |
| mostly laptops on campus Wi-Fi             | 10 % | 30 % | 60 % |                   0.047 |                  0.508 |

Worked example (inputs are **examples, not a forecast**): 2,000 students x 20 hours a month = 40,000 viewing hours.
Balanced mix: **lecture-like~1.7 TB / month, high-motion ~14 TB / month**. Storage of one hour of lectures (three renditions,
no original): lecture-like ~0.13 GB, high-motion ~1.2 GB. A provider's price per GB is multiplied by those numbers; the
spread between the two samples is a factor of 8, so the content matters at least as much as the provider.

## 5. Prices to fill in (quotes, not guesses)

One block per provider, in the same units, so the formula above can be evaluated for each. Leave a field empty until a quote
or the provider's price page, with its date, is in hand.

| field                                               | Google Cloud (Transcoder API + Cloud Storage + Cloud CDN) | Bunny Stream | Cloudflare Stream | Mux |
| --------------------------------------------------- | --------------------------------------------------------- | ------------ | ----------------- | --- |
| price page / quote, date                            |                                                           |              |                   |     |
| egress (delivery) per GB, by region and volume tier |                                                           |              |                   |     |
| egress price for the college's region (India)       |                                                           |              |                   |     |
| storage per GB-month (or per minute stored)         |                                                           |              |                   |     |
| encoding / transcoding per minute of video          |                                                           |              |                   |     |
| encoding included in the storage price?             |                                                           |              |                   |     |
| minimum monthly fee / plan                          |                                                           |              |                   |     |
| free allowance (GB, minutes)                        |                                                           |              |                   |     |
| signed URLs / token authentication included?        |                                                           |              |                   |     |
| captions (WebVTT) supported?                        |                                                           |              |                   |     |
| playback needs the provider's player, or plain HLS? |                                                           |              |                   |     |
| upload protocol (tus, resumable URL)                |                                                           |              |                   |     |
| data location / residency options                   |                                                           |              |                   |     |
| monthly egress (GB) from section 4                  |                                                           |              |                   |     |
| **monthly cost**                                    |                                                           |              |                   |     |

## 6. Caveats

- Two synthetic clips are not a lecture archive: re-measure on real recordings (the bench takes a directory of clips if the
  generator in `video-bench.ts` is replaced by their paths).
- Players download the quality they choose, and a viewer who seeks or replays downloads the segments again unless the browser
  caches them (`Cache-Control: private, max-age=86400` on segments for the local provider). The formula counts viewing hours,
  not unique bytes: real egress can be lower with caching and higher with re-watching.
- A managed provider may use its own ladder and encoder settings; its GB per hour will not equal ours. The numbers here
  describe **our** ladder and are the basis for comparing delivery prices, not a promise about another provider's output.
- Audio is included (64 / 96 / 96 kbps AAC in the three renditions).
