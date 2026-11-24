import type { Notification } from '@lms/backend/contracts';

// The words of a notification, from its type and its display-safe params (titles, counts, dates). Plain text: React escapes it.

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const when = (iso: unknown) => {
  const d = new Date(str(iso));
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
};

export interface NotificationText {
  title: string;
  detail: string;
}

export function notificationText(n: Pick<Notification, 'type' | 'params'>): NotificationText {
  const p = n.params;
  const item = str(p.item);
  const course = str(p.course);
  const hours = num(p.hours) === 1 ? '1 hour' : `${num(p.hours)} hours`;
  switch (n.type) {
    case 'grade_released':
      return p.kind === 'assessment'
        ? { title: `Your result for ${item} is ready`, detail: course }
        : {
            title: `Your work on ${item} has been returned`,
            detail: p.hasFeedback === true ? `${course} · with feedback` : course,
          };
    case 'due_soon':
      return { title: `Due in ${hours}: ${item}`, detail: `${course} · due ${when(p.dueAt)}` };
    case 'quiz_opens':
      return { title: `Opens in ${hours}: ${item}`, detail: `${course} · ${when(p.at)}` };
    case 'quiz_closes':
      return { title: `Closes in ${hours}: ${item}`, detail: `${course} · ${when(p.at)}` };
    case 'erasure_request_received':
      return {
        title: 'A member asked to be erased from the college',
        detail: 'Review the request',
      };
    case 'erasure_request_approved':
      return {
        title: 'Your request to be erased was approved',
        detail: `It is carried out after ${num(p.days)} days; you can still cancel`,
      };
    case 'erasure_request_rejected':
      return { title: 'Your request to be erased was not approved', detail: 'Nothing was changed' };
    case 'erasure_request_cancelled':
      return { title: 'Your request to be erased was cancelled', detail: 'Nothing was changed' };
    case 'erasure_request_expired':
      return {
        title: 'Your request to be erased has expired',
        detail: 'Nobody decided within 30 days',
      };
    case 'extension_granted':
      return { title: `Your deadline for ${item} was changed`, detail: course };
    case 'accommodation_updated':
      return { title: `Your arrangements for ${item} were updated`, detail: course };
    case 'content_digest':
      return {
        title: `New in ${course}: ${plural(num(p.count), 'item')}`,
        detail: Array.isArray(p.titles) ? p.titles.map((x) => str(x)).join(', ') : '',
      };
    case 'grading_digest':
      return {
        title: `${plural(num(p.total), 'submission')} waiting to be graded`,
        detail: coursesLine(p.courses),
      };
    case 'atrisk_weekly':
      return {
        title: `This week: ${plural(num(p.total), 'learner')} flagged in your courses`,
        detail: coursesLine(p.courses),
      };
    case 'gradebook_submitted':
      return {
        title: `Gradebook submitted for approval: ${course}`,
        detail: `Version ${num(p.version)}`,
      };
    case 'gradebook_returned':
      return { title: `Gradebook returned: ${course}`, detail: `Version ${num(p.version)}` };
    case 'gradebook_approved':
      return { title: `Gradebook approved: ${course}`, detail: `Version ${num(p.version)}` };
    case 'video_ready':
      return { title: `Video ready: ${str(p.name)}`, detail: course };
    case 'video_failed':
      return { title: `Video could not be processed: ${str(p.name)}`, detail: course };
    case 'import_finished':
      return {
        title: `Import finished: ${str(p.fileName)}`,
        detail:
          p.status === 'failed'
            ? 'The import failed'
            : `${plural(num(p.processed), 'row')} applied${num(p.failed) > 0 ? `, ${num(p.failed)} failed` : ''}`,
      };
    case 'course_health_weekly':
      return {
        title: `This week: ${plural(num(p.count), 'course needs', 'courses need')} attention`,
        detail: '',
      };
    case 'usage_closed':
      return {
        title: `Usage closed for ${str(p.month).slice(0, 7)}`,
        detail: plural(num(p.colleges), 'college'),
      };
    default:
      return { title: 'Notification', detail: '' };
  }
}

function coursesLine(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return v
    .map((c) => {
      const o = c as { course?: unknown; count?: unknown };
      return `${str(o.course)}: ${num(o.count)}`;
    })
    .join(' · ');
}
