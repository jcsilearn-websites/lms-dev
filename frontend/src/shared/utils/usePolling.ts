import { useEffect, useRef } from 'react';

/** 1 s, 1 s, 2 s, 3 s, 4 s, then 5 s for as long as the job runs. */
export function pollDelay(attempt: number): number {
  return attempt < 2 ? 1000 : Math.min(5000, attempt * 1000);
}

interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Calls `poll` repeatedly while `enabled`, with a growing delay (pollDelay). It pauses while the tab
 * is hidden (Page Visibility API: a background tab must not keep hitting the API) and, when the tab
 * becomes visible again, polls at once and starts over at the short delay. Turning `enabled` off
 * (a terminal status) or unmounting stops it for good. Errors are swallowed: the next tick retries.
 */
export function usePolling(opts: {
  enabled: boolean;
  poll: () => Promise<unknown>;
  delay?: (attempt: number) => number;
  /** injectable for tests; defaults to `document` */
  visibility?: VisibilitySource;
}): void {
  const pollRef = useRef(opts.poll);
  pollRef.current = opts.poll;
  const delayFn = opts.delay ?? pollDelay;
  const source = opts.visibility ?? (typeof document === 'undefined' ? undefined : document);

  useEffect(() => {
    if (!opts.enabled) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const hidden = () => source?.visibilityState === 'hidden';
    const schedule = () => {
      if (stopped || hidden()) return;
      timer = setTimeout(run, delayFn(attempt));
    };
    const run = async () => {
      timer = undefined;
      if (stopped || hidden()) return;
      try {
        await pollRef.current();
      } catch {
        // keep going: the next tick tries again
      }
      attempt += 1;
      schedule();
    };
    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (hidden()) return;
      attempt = 0;
      void run();
    };

    source?.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      source?.removeEventListener('visibilitychange', onVisibility);
    };
  }, [opts.enabled, delayFn, source]);
}
