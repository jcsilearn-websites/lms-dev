// The ONLY place that imports the player chunk (hls.js), and only through a dynamic import(): the bundler gives it its
// own chunk, so no screen that does not play video pays for it. Tested by scripts/check-bundle-size.mjs: hls.js must
// be reachable only from VideoPlayer.tsx, and that only from here.

export const loadPlayer = () => import('./VideoPlayer');
