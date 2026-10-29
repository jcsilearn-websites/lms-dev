import type { Status } from '../ui/StatusRow';

export interface HealthView {
  text: string;
  status: Status;
}

/** Maps a health query outcome to what the UI shows. */
export function describeHealth(state: {
  isPending: boolean;
  failed: boolean;
  ok?: boolean;
  httpStatus?: number;
}): HealthView {
  if (state.isPending) return { text: 'checking…', status: 'pending' };
  if (state.failed) return { text: 'unreachable', status: 'down' };
  return state.ok
    ? { text: 'ok', status: 'up' }
    : { text: `error (${state.httpStatus})`, status: 'down' };
}
