import type { ImportStatus } from '@lms/backend/contracts';

const LABELS: Record<ImportStatus, string> = {
  parsing: 'Reading the file',
  validated: 'Ready to review',
  failed: 'Failed',
  queued: 'Waiting to start',
  processing: 'Importing',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  cancelled: 'Cancelled',
};

export const statusLabel = (s: ImportStatus): string => LABELS[s];

export function statusTone(s: ImportStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  if (s === 'completed') return 'success';
  if (s === 'completed_with_errors' || s === 'validated') return 'warning';
  if (s === 'failed' || s === 'cancelled') return 'danger';
  return 'neutral';
}
