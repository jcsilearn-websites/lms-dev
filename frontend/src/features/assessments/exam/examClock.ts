// The exam countdown. The deadline belongs to the SERVER: this only displays it. The clock of the device is not
// trusted (a wrong or changed clock must not give or take time), so the remaining time is measured from the moment the
// server's answer arrived with a MONOTONIC timer (`performance.now`), which a change of the system clock does not move.

export const WARNING_MINUTES = [10, 5, 1] as const;
export type WarningMinutes = (typeof WARNING_MINUTES)[number];

export class ExamClock {
  private deadlineMs = 0;
  private serverAtSync = 0;
  private monoAtSync = 0;

  /** `mono` is injectable for tests; the default is the monotonic clock of the browser. */
  constructor(private readonly mono: () => number = () => performance.now()) {}

  /** Call with every answer that carries the server time and the deadline (read, save). */
  sync(serverNowIso: string, deadlineIso: string): void {
    this.serverAtSync = new Date(serverNowIso).getTime();
    this.deadlineMs = new Date(deadlineIso).getTime();
    this.monoAtSync = this.mono();
  }

  /** The server's time now, as far as this device can tell (the last sync plus the monotonic time since). */
  serverNow(): number {
    return this.serverAtSync + (this.mono() - this.monoAtSync);
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.serverNow());
  }

  isOver(): boolean {
    return this.remainingMs() <= 0;
  }
}

/**
 * The warning to show now, once each: when the remaining time has dropped to 10, 5 or 1 minute. `shown` remembers what
 * was announced (a reload re-announces only the thresholds still ahead: if 4 minutes are left it says 5, not 10).
 */
export function dueWarning(remainingMs: number, shown: Set<WarningMinutes>): WarningMinutes | null {
  // the smallest threshold that has been crossed is the one that matters
  const crossed = WARNING_MINUTES.filter((m) => remainingMs <= m * 60_000 && remainingMs > 0);
  const m = crossed[crossed.length - 1];
  if (m === undefined || shown.has(m)) return null;
  for (const bigger of WARNING_MINUTES) if (bigger >= m) shown.add(bigger);
  return m;
}

/** 1:05:09 / 05:09 */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** For the timer's accessible name: "4 minutes 5 seconds left". */
export function spokenRemaining(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (h === 0 && m < 5) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return `${parts.join(' ') || '0 seconds'} left`;
}
