// hls.js ships its types for the full build only; the "light" build (no alternate audio, no subtitle tracks in the
// manifest: captions are WebVTT <track> elements) has the same API. It is what the player loads: smaller chunk.
declare module 'hls.js/light' {
  import Hls from 'hls.js';
  export default Hls;
}
