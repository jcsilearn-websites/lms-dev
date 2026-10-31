import type { HeartbeatResponse, ItemStatus, MyProgress } from '@lms/backend/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { progressKeys } from './progress.api';

// The learner's progress is one small read per course. A change patches the cached item at once (the page shows it
// without waiting), and the percentages, which depend on every item, are refreshed from the server afterwards.

/** Sets the status of one item in the cached progress of a course; true when something changed. */
export function patchItemStatus(
  qc: QueryClient,
  offeringId: string,
  itemId: string,
  patch: { status: ItemStatus; watchedPercent?: number | null; positionSeconds?: number | null },
): boolean {
  let changed = false;
  qc.setQueryData<MyProgress>(progressKeys.offering(offeringId), (old) => {
    if (!old) return old;
    return {
      ...old,
      items: old.items.map((i) => {
        if (i.itemId !== itemId) return i;
        if (
          i.status === patch.status &&
          (patch.watchedPercent === undefined || i.watchedPercent === patch.watchedPercent)
        ) {
          return i;
        }
        changed = true;
        return {
          ...i,
          status: patch.status,
          watchedPercent:
            patch.watchedPercent === undefined ? i.watchedPercent : patch.watchedPercent,
          positionSeconds:
            patch.positionSeconds === undefined ? i.positionSeconds : patch.positionSeconds,
        };
      }),
    };
  });
  return changed;
}

/** The module and course percentages (and "My courses") changed: ask the server for the new numbers. */
export function refreshPercentages(qc: QueryClient, offeringId: string): void {
  void qc.invalidateQueries({ queryKey: progressKeys.offering(offeringId) });
  void qc.invalidateQueries({ queryKey: progressKeys.me });
}

/** What a heartbeat answer changes in the cache. Returns true when the item just became completed. */
export function applyHeartbeat(
  qc: QueryClient,
  offeringId: string,
  itemId: string,
  r: HeartbeatResponse,
): boolean {
  const before = qc
    .getQueryData<MyProgress>(progressKeys.offering(offeringId))
    ?.items.find((i) => i.itemId === itemId)?.status;
  const status: ItemStatus = r.completed
    ? 'completed'
    : r.watchedSeconds > 0
      ? 'in_progress'
      : 'not_started';
  patchItemStatus(qc, offeringId, itemId, {
    status,
    watchedPercent: r.percent,
    positionSeconds: r.positionSeconds,
  });
  const justDone = r.completed && before !== 'completed';
  if (justDone) refreshPercentages(qc, offeringId);
  return justDone;
}
