import { useSyncExternalStore } from 'react';

/**
 * Reactive `matchMedia`. The first render already has the right answer (no layout shift), and a
 * missing matchMedia (tests, very old browsers) counts as "matches" so the desktop layout is used.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true),
    () => true,
  );
}
