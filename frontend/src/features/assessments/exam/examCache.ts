import type { AttemptDto } from '@lms/backend/contracts';

// The paper of a running attempt is kept in this browser (the questions the learner is looking at anyway) so that a
// reload while the API cannot be reached still opens the exam, with the answers the queue kept. It carries the server
// clock at the time it was stored, to keep counting the deadline when the server cannot be asked. It is removed when the
// attempt ends and ignored after two days.

const KEEP_MS = 48 * 3600_000;
const key = (attemptId: string) => `lms:exam-paper:${attemptId}`;

interface Stored {
  v: 1;
  savedAt: number;
  /** server clock minus the device clock when the paper was read */
  skewMs: number;
  data: AttemptDto;
}

export function savePaper(attemptId: string, data: AttemptDto, now = Date.now()): void {
  try {
    const stored: Stored = {
      v: 1,
      savedAt: now,
      skewMs: new Date(data.attempt.serverNow).getTime() - now,
      data,
    };
    localStorage.setItem(key(attemptId), JSON.stringify(stored));
  } catch {
    // storage full or blocked: the exam works, only the offline reload does not
  }
}

/** The kept paper with its clock moved to NOW (server time estimated from the device clock and the stored skew). */
export function loadPaper(attemptId: string, now = Date.now()): AttemptDto | null {
  try {
    const raw = localStorage.getItem(key(attemptId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (s?.v !== 1 || now - s.savedAt > KEEP_MS) return null;
    return {
      ...s.data,
      attempt: { ...s.data.attempt, serverNow: new Date(now + s.skewMs).toISOString() },
    };
  } catch {
    return null;
  }
}

/** The server has these answers now: a later offline reload shows them too (the clock and the questions stay as stored). */
export function updateAnswers(
  attemptId: string,
  states: readonly { position: number; answer: unknown; flagged: boolean; rev: number }[],
): void {
  try {
    const raw = localStorage.getItem(key(attemptId));
    if (!raw) return;
    const s = JSON.parse(raw) as Stored;
    const by = new Map(states.map((x) => [x.position, x]));
    s.data = {
      ...s.data,
      questions: s.data.questions.map((q) => {
        const x = by.get(q.position);
        return x
          ? { ...q, answer: x.answer as typeof q.answer, flagged: x.flagged, rev: x.rev }
          : q;
      }),
    };
    localStorage.setItem(key(attemptId), JSON.stringify(s));
  } catch {
    // storage full or blocked
  }
}

export function clearPaper(attemptId: string): void {
  try {
    localStorage.removeItem(key(attemptId));
  } catch {
    // nothing to remove
  }
}
