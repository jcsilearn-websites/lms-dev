import type { GradebookStatus } from '@lms/backend/contracts';

export const STATUS_TEXT: Record<GradebookStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  returned: 'Returned to the instructor',
  locked: 'Approved and locked',
};
