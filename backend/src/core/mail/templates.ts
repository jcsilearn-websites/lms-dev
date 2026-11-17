import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { brandColor, html, oneLine, type SafeHtml, safeUrl } from './html';

/**
 * Every email the LMS sends, as typed templates: HTML + plain text from ONE content description, so the two never drift.
 *
 * PRIVACY (a rule, enforced by the schemas): the params of a template can only hold titles, counts, dates and links. There is
 * no field for a mark, a score, feedback, an override / waiver / extension / accommodation reason or at-risk evidence, and the
 * schemas refuse unknown fields (`additionalProperties: false`), so a param that is not declared here is a render error (the
 * outbox row goes `dead`) instead of an email. Emails say "something is ready" and link to the LMS.
 */

const str = (max = 200) => Type.String({ maxLength: max });
const link = Type.String({ pattern: '^/[A-Za-z0-9]', maxLength: 500 });
const obj = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const courseCounts = Type.Array(obj({ course: str(), count: Type.Integer({ minimum: 0 }) }), {
  maxItems: 10,
});

export const TEMPLATE_PARAMS = {
  invite: obj({
    membershipId: Type.Optional(Type.String()),
    token: str(200),
    days: Type.Integer(),
  }),
  password_reset: obj({ token: str(200), minutes: Type.Integer(), host: Type.Optional(str(20)) }),
  password_changed: obj({}),
  admin_promoted: obj({}),
  grade_released: obj({
    course: str(),
    item: str(),
    kind: Type.Union([Type.Literal('assignment'), Type.Literal('assessment')]),
    hasFeedback: Type.Boolean(),
    link,
  }),
  due_reminder: obj({ course: str(), item: str(), hours: Type.Integer(), dueAt: str(40), link }),
  quiz_opens: obj({ course: str(), item: str(), hours: Type.Integer(), at: str(40), link }),
  quiz_closes: obj({ course: str(), item: str(), hours: Type.Integer(), at: str(40), link }),
  extension_granted: obj({ course: str(), item: str(), link }),
  accommodation_updated: obj({ course: str(), item: str(), link }),
  content_digest: obj({
    course: str(),
    count: Type.Integer({ minimum: 1 }),
    titles: Type.Array(str(), { maxItems: 5 }),
    link,
  }),
  grading_digest: obj({ total: Type.Integer(), courses: courseCounts, link }),
  atrisk_weekly: obj({ total: Type.Integer(), courses: courseCounts, link }),
  gradebook_submitted: obj({ course: str(), version: Type.Integer(), link }),
  gradebook_returned: obj({ course: str(), version: Type.Integer(), link }),
  gradebook_approved: obj({ course: str(), version: Type.Integer(), link }),
  video_ready: obj({ course: str(), name: str(255), link }),
  video_failed: obj({ course: str(), name: str(255), link }),
  import_finished: obj({
    fileName: str(255),
    status: str(40),
    processed: Type.Integer(),
    failed: Type.Integer(),
    link,
  }),
  course_health_weekly: obj({ count: Type.Integer(), link }),
  usage_closed: obj({ month: str(20), colleges: Type.Integer(), link }),
} as const;

export type TemplateName = keyof typeof TEMPLATE_PARAMS;
export type TemplateParams<T extends TemplateName> = Static<(typeof TEMPLATE_PARAMS)[T]>;
export const TEMPLATE_NAMES = Object.keys(TEMPLATE_PARAMS) as TemplateName[];

/** Category labels (preferences page, unsubscribe page and email footers use the same words). */
export const CATEGORY_LABELS: Record<string, string> = {
  security: 'Account and security',
  learning_deadlines: 'Deadlines and reminders',
  learning_grades: 'Grades and results',
  learning_content: 'New course content',
  teaching_grading: 'Grading and gradebooks',
  teaching_updates: 'Teaching updates',
  admin: 'Administration',
};

export interface TemplateContext {
  /** null on the admin host (platform mail) */
  college: { name: string; color: string | null } | null;
  /** the site the links point to: https://<slug>.<base> or the admin host */
  origin: string;
  timeZone: string;
  category: string;
  /** the SPA unsubscribe page (non-security mail only) */
  unsubscribeUrl: string | null;
}

interface Content {
  subject: string;
  heading: string;
  paragraphs: string[];
  list?: string[];
  action?: { label: string; url: string };
  note?: string;
}

export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (s: string) => `“${s}”`;
const hoursText = (h: number) => (h === 1 ? '1 hour' : `${h} hours`);
const at = (ctx: TemplateContext, path: string) => `${ctx.origin}${path}`;
const monthName = (month: string) => {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? month
    : new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        d,
      );
};

type Builders = { [K in TemplateName]: (p: TemplateParams<K>, ctx: TemplateContext) => Content };

const college = (ctx: TemplateContext) => ctx.college?.name ?? 'JCS iLearn';

const BUILDERS: Builders = {
  invite: (p, ctx) => ({
    subject: `You're invited to ${college(ctx)} on JCS iLearn`,
    heading: "You're invited",
    paragraphs: [
      `${college(ctx)} has invited you to its learning site on JCS iLearn.`,
      `Accept the invitation within ${plural(p.days, 'day')} to set up your account.`,
    ],
    action: { label: 'Accept the invitation', url: `${ctx.origin}/accept-invite?token=${p.token}` },
    note: 'If you did not expect this invitation, you can ignore this email.',
  }),
  password_reset: (p, ctx) => ({
    subject: 'Reset your password',
    heading: 'Reset your password',
    paragraphs: [
      'Someone asked to reset the password of your account.',
      `Use this link within ${p.minutes} minutes to choose a new password. It works once.`,
    ],
    action: {
      label: 'Choose a new password',
      url: `${ctx.origin}/reset-password?token=${p.token}`,
    },
    note: 'If you did not ask for this, ignore this email: your password stays the same.',
  }),
  password_changed: (_p, ctx) => ({
    subject: 'Your password was changed',
    heading: 'Your password was changed',
    paragraphs: [
      'The password of your account was just changed, and your other sessions were signed out.',
      "If this was not you, reset your password now and tell your college's administrator.",
    ],
    action: { label: 'Reset your password', url: at(ctx, '/forgot-password') },
  }),
  // deliberately NO link (nothing to click in an email about privileges): the member signs in as usual
  admin_promoted: (_p, ctx) => ({
    subject: `You are now an institution admin of ${college(ctx)}`,
    heading: 'You are now an institution admin',
    paragraphs: [
      `You are now an institution admin of ${college(ctx)}.`,
      'For your security you have been signed out: sign in again to use the new access.',
    ],
  }),
  grade_released: (p, ctx) => ({
    subject:
      p.kind === 'assessment'
        ? `Your result for ${p.item} is ready`
        : `Your work on ${p.item} has been returned`,
    heading: p.kind === 'assessment' ? 'Your result is ready' : 'Your work has been returned',
    paragraphs: [
      p.kind === 'assessment'
        ? `Your result for ${quoted(p.item)} in ${p.course} is ready.`
        : `Your work on ${quoted(p.item)} in ${p.course} has been graded and returned.${p.hasFeedback ? ' Your instructor also left feedback.' : ''}`,
      'Open JCS iLearn to see it.',
    ],
    action: { label: 'View it in JCS iLearn', url: at(ctx, p.link) },
  }),
  due_reminder: (p, ctx) => ({
    subject: `Due in ${hoursText(p.hours)}: ${p.item}`,
    heading: `Due in ${hoursText(p.hours)}`,
    paragraphs: [
      `${quoted(p.item)} in ${p.course} is due ${formatWhen(p.dueAt, ctx.timeZone)}.`,
      'You have not handed anything in yet.',
    ],
    action: { label: 'Open the assignment', url: at(ctx, p.link) },
  }),
  quiz_opens: (p, ctx) => ({
    subject: `Opens in ${hoursText(p.hours)}: ${p.item}`,
    heading: `Opens in ${hoursText(p.hours)}`,
    paragraphs: [`${quoted(p.item)} in ${p.course} opens ${formatWhen(p.at, ctx.timeZone)}.`],
    action: { label: 'Open it', url: at(ctx, p.link) },
  }),
  quiz_closes: (p, ctx) => ({
    subject: `Closes in ${hoursText(p.hours)}: ${p.item}`,
    heading: `Closes in ${hoursText(p.hours)}`,
    paragraphs: [
      `${quoted(p.item)} in ${p.course} closes ${formatWhen(p.at, ctx.timeZone)}.`,
      'You have not submitted it yet.',
    ],
    action: { label: 'Open it', url: at(ctx, p.link) },
  }),
  extension_granted: (p, ctx) => ({
    subject: `Your deadline for ${p.item} was changed`,
    heading: 'Your deadline was changed',
    paragraphs: [
      `Your deadline for ${quoted(p.item)} in ${p.course} was changed.`,
      'Open JCS iLearn to see the new date.',
    ],
    action: { label: 'Open it', url: at(ctx, p.link) },
  }),
  accommodation_updated: (p, ctx) => ({
    subject: `Your arrangements for ${p.item} were updated`,
    heading: 'Your arrangements were updated',
    paragraphs: [
      `Your arrangements for ${quoted(p.item)} in ${p.course} were updated.`,
      'Open JCS iLearn to see the details.',
    ],
    action: { label: 'Open it', url: at(ctx, p.link) },
  }),
  content_digest: (p, ctx) => ({
    subject: `New in ${p.course}: ${plural(p.count, 'item')}`,
    heading: `New in ${p.course}`,
    paragraphs: [`${plural(p.count, 'new item is', 'new items are')} available in ${p.course}:`],
    list: [
      ...p.titles,
      ...(p.count > p.titles.length ? [`and ${plural(p.count - p.titles.length, 'more')}`] : []),
    ],
    action: { label: 'Open the course', url: at(ctx, p.link) },
  }),
  grading_digest: (p, ctx) => ({
    subject: `${plural(p.total, 'submission')} waiting to be graded`,
    heading: 'Work waiting to be graded',
    paragraphs: [
      `${plural(p.total, 'hand-in or attempt is', 'hand-ins and attempts are')} waiting:`,
    ],
    list: p.courses.map((c) => `${c.course}: ${c.count}`),
    action: { label: 'Open your teaching dashboard', url: at(ctx, p.link) },
  }),
  atrisk_weekly: (p, ctx) => ({
    subject: `This week: ${plural(p.total, 'learner')} flagged in your courses`,
    heading: 'Learners who may need help',
    paragraphs: [
      `The at-risk rules flagged ${plural(p.total, 'learner')} in your courses:`,
      'The at-risk page of each course shows which rules fired, and why.',
    ],
    list: p.courses.map((c) => `${c.course}: ${c.count}`),
    action: { label: 'Open your teaching dashboard', url: at(ctx, p.link) },
  }),
  gradebook_submitted: (p, ctx) => ({
    subject: `Gradebook submitted for approval: ${p.course}`,
    heading: 'A gradebook is waiting for approval',
    paragraphs: [`The gradebook of ${p.course} (version ${p.version}) was submitted for approval.`],
    action: { label: 'Review gradebooks', url: at(ctx, p.link) },
  }),
  gradebook_returned: (p, ctx) => ({
    subject: `Gradebook returned: ${p.course}`,
    heading: 'Your gradebook was returned',
    paragraphs: [
      `The gradebook of ${p.course} (version ${p.version}) was returned for changes.`,
      "The reviewer's comment is in JCS iLearn.",
    ],
    action: { label: 'Open the gradebook', url: at(ctx, p.link) },
  }),
  gradebook_approved: (p, ctx) => ({
    subject: `Gradebook approved: ${p.course}`,
    heading: 'Your gradebook was approved',
    paragraphs: [`The gradebook of ${p.course} (version ${p.version}) was approved and locked.`],
    action: { label: 'Open the gradebook', url: at(ctx, p.link) },
  }),
  video_ready: (p, ctx) => ({
    subject: `Video ready: ${p.name}`,
    heading: 'Your video is ready',
    paragraphs: [`${quoted(p.name)} in ${p.course} was processed and can be watched now.`],
    action: { label: 'Open the course builder', url: at(ctx, p.link) },
  }),
  video_failed: (p, ctx) => ({
    subject: `Video could not be processed: ${p.name}`,
    heading: 'Your video could not be processed',
    paragraphs: [
      `${quoted(p.name)} in ${p.course} could not be processed.`,
      'The course builder shows the reason.',
    ],
    action: { label: 'Open the course builder', url: at(ctx, p.link) },
  }),
  import_finished: (p, ctx) => ({
    subject: `Import finished: ${p.fileName}`,
    heading: 'Your import has finished',
    paragraphs: [
      p.status === 'failed'
        ? `The import of ${quoted(p.fileName)} failed.`
        : `The import of ${quoted(p.fileName)} finished: ${plural(p.processed, 'row')} applied${p.failed > 0 ? `, ${p.failed} failed` : ''}.`,
    ],
    action: { label: 'Open the import', url: at(ctx, p.link) },
  }),
  course_health_weekly: (p, ctx) => ({
    subject: `This week: ${plural(p.count, 'course needs', 'courses need')} attention`,
    heading: 'Courses that need attention',
    paragraphs: [
      `${plural(p.count, 'running course needs', 'running courses need')} attention (no new content for a while, or work waiting to be graded for too long).`,
    ],
    action: { label: 'Open the college dashboard', url: at(ctx, p.link) },
  }),
  usage_closed: (p, ctx) => ({
    subject: `Usage closed for ${monthName(p.month)}`,
    heading: 'Monthly usage closed',
    paragraphs: [
      `The usage of ${plural(p.colleges, 'college')} for ${monthName(p.month)} was closed and frozen.`,
    ],
    action: { label: 'Open platform usage', url: at(ctx, p.link) },
  }),
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Validates the params against the template's schema (unknown fields refused), then builds the content. */
export function contentOf(template: string, params: unknown, ctx: TemplateContext): Content {
  const schema = (TEMPLATE_PARAMS as Record<string, TSchema>)[template];
  const build = (BUILDERS as Record<string, (p: unknown, c: TemplateContext) => Content>)[template];
  if (!schema || !build) throw new TemplateError(`unknown template ${template}`);
  if (!Value.Check(schema, params)) {
    const first = [...Value.Errors(schema, params)][0];
    throw new TemplateError(
      `invalid params for ${template}: ${first?.path ?? ''} ${first?.message ?? ''}`.trim(),
    );
  }
  return build(params, ctx);
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function render(template: string, params: unknown, ctx: TemplateContext): RenderedEmail {
  const c = contentOf(template, params, ctx);
  const security = ctx.category === 'security';
  const site = ctx.college ? `${ctx.college.name} on JCS iLearn` : 'JCS iLearn';
  const footerLines = security
    ? [`This is a security email about your account at ${site}. It cannot be switched off.`]
    : [
        `You receive this email from ${site}.`,
        ...(ctx.college ? [`Choose which emails you get: ${ctx.origin}/me/notifications`] : []),
        ...(ctx.unsubscribeUrl
          ? [
              `Stop emails about ${(CATEGORY_LABELS[ctx.category] ?? ctx.category).toLowerCase()}: ${ctx.unsubscribeUrl}`,
            ]
          : []),
      ];

  // ---- plain text
  const text = [
    c.heading,
    '',
    ...c.paragraphs,
    ...(c.list ? ['', ...c.list.map((l) => `- ${l}`)] : []),
    ...(c.action ? ['', `${c.action.label}:`, c.action.url] : []),
    ...(c.note ? ['', c.note] : []),
    '',
    '--',
    ...footerLines,
  ].join('\n');

  // ---- HTML (table layout, inline styles: what mail clients render)
  const color = brandColor(ctx.college?.color);
  const actionUrl = c.action ? safeUrl(c.action.url) : null;
  const footer: SafeHtml[] = security
    ? [html`<p style="margin:0 0 6px">${footerLines[0]}</p>`]
    : [
        html`<p style="margin:0 0 6px">You receive this email from ${site}.</p>`,
        ctx.college
          ? html`<p style="margin:0 0 6px"><a href="${safeUrl(`${ctx.origin}/me/notifications`)}" style="color:#334155">Choose which emails you get</a></p>`
          : html``,
        ctx.unsubscribeUrl
          ? html`<p style="margin:0"><a href="${safeUrl(ctx.unsubscribeUrl)}" style="color:#334155">Stop emails about ${(CATEGORY_LABELS[ctx.category] ?? ctx.category).toLowerCase()}</a></p>`
          : html``,
      ];
  const body = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${oneLine(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${color};color:#ffffff;padding:16px 24px;font-size:16px;font-weight:bold">${site}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${c.heading}</h1>
${c.paragraphs.map((p) => html`<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${p}</p>`)}
${c.list ? html`<ul style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5">${c.list.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
${
  actionUrl && c.action
    ? html`<p style="margin:20px 0"><a href="${actionUrl}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">${c.action.label}</a></p>
<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all">${actionUrl}</p>`
    : ''
}
${c.note ? html`<p style="margin:12px 0 0;font-size:13px;color:#475569">${c.note}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;color:#475569">${footer}</td></tr>
</table></td></tr></table>
</body></html>`;

  return { subject: oneLine(c.subject), text, html: body.value };
}
