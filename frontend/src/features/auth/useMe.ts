import type { MeResponse } from '@lms/backend/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../shared/api/client';
import { fetchMe, meKey } from './auth.api';

/** /auth/me is cached for 5 minutes: it is read on every navigation but changes almost never. */
export const ME_STALE_MS = 5 * 60_000;

export const meQueryOptions = {
  queryKey: meKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchMe(signal),
  staleTime: ME_STALE_MS,
  retry: false,
} as const;

/** The signed-in user, or null when there is no session (a 401 is an answer here, not a failure). */
export async function loadMe(
  ensure: (o: typeof meQueryOptions) => Promise<MeResponse>,
): Promise<MeResponse | null> {
  try {
    return await ensure(meQueryOptions);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function useMe() {
  return useQuery(meQueryOptions);
}

/**
 * What the signed-in user may do, from /auth/me. This only decides what to SHOW (nav entries,
 * buttons): hiding is cosmetic. The backend checks every request again and is the source of truth.
 */
export function usePermissions() {
  const me = useMe().data;
  const set = new Set(me?.permissions ?? []);
  return {
    me,
    has: (permission: string) => set.has(permission),
    hasAny: (...permissions: string[]) => permissions.some((p) => set.has(p)),
  };
}
