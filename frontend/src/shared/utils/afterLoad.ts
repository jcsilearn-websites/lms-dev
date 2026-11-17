import { useEffect, useState } from 'react';

/**
 * Work that is not needed to PAINT the page (the notification bell's first poll, the email-status banner) waits until the page has
 * loaded and gone quiet, so it never competes with the content the visitor came for (Lighthouse total blocking time, and a phone on
 * a slow network). Tests set `afterLoad.delayMs = 0`.
 */
export const afterLoad = { delayMs: 2500 };

export function useAfterLoad(): boolean {
  const [ready, setReady] = useState(afterLoad.delayMs === 0);
  useEffect(() => {
    if (ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      timer = setTimeout(() => setReady(true), afterLoad.delayMs);
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => {
      window.removeEventListener('load', start);
      if (timer) clearTimeout(timer);
    };
  }, [ready]);
  return ready;
}
