// "An exam is running in this tab": the one fact the service worker's update logic needs. The exam page holds the lock while its attempt is in progress;
// the update flow (register.ts) never applies a new version while it is held, and the worker asks every page (EXAM_BUSY?) before it takes over.

let holders = 0;
const idleListeners = new Set<() => void>();

/** Takes the lock; the returned function releases it (once). Several holders are counted. */
export function acquireExamLock(): () => void {
  holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) for (const listener of [...idleListeners]) listener();
  };
}

export const isExamActive = () => holders > 0;

/** Calls `listener` every time the last holder lets go; returns how to stop. */
export function onExamIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => {
    idleListeners.delete(listener);
  };
}
