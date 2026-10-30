// What the video player reports. Step 8 (progress tracking) subscribes here; nothing is stored yet. This file has no
// dependency on the player (hls.js), so any screen can import it without pulling the player into its chunk.

export type PlayerEventType = 'play' | 'pause' | 'seek' | 'ended' | 'heartbeat';

export interface PlayerEvent {
  type: PlayerEventType;
  itemId: string;
  videoId: string;
  /** where the viewer is, in milliseconds from the start */
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  /** ISO time of the event */
  at: string;
}

export type PlayerEventSink = (event: PlayerEvent) => void;

const sinks = new Set<PlayerEventSink>();

/** The channel step 8 listens on. Returns the function that stops listening. */
export function subscribeToPlayerEvents(sink: PlayerEventSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

/** Called by the player. A sink that throws never breaks playback. */
export function emitPlayerEvent(event: PlayerEvent): void {
  for (const sink of sinks) {
    try {
      sink(event);
    } catch {
      // a listener's bug must not stop the video
    }
  }
}

/** Seconds between `heartbeat` events while the video plays. */
export const HEARTBEAT_SECONDS = 15;
