import { describe, expect, it } from 'vitest';
import {
  brandColor,
  contrast,
  displayName,
  escapeHtml,
  html,
  NEUTRAL_BRAND,
  oneLine,
} from '../html';
import {
  contentOf,
  render,
  TEMPLATE_NAMES,
  TEMPLATE_PARAMS,
  type TemplateContext,
  TemplateError,
} from '../templates';

// Every template renders HTML + text from ONE description (snapshots below), escapes every user-provided value, puts a
// subject on one line, links only to the college's site, and refuses params it does not declare (the privacy rule).

const HOSTILE = `<script>alert("x")</script> & 'quotes' ‮evil`;
const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  college: { name: 'St. Joseph’s College', color: '#1d4ed8' },
  origin: 'https://stjosephs.jcs-ilearn.example',
  timeZone: 'Asia/Kolkata',
  category: 'learning_grades',
  unsubscribeUrl: 'https://stjosephs.jcs-ilearn.example/unsubscribe?t=v1.abc.def',
  ...over,
});

const SAMPLE: Record<string, Record<string, unknown>> = {
  invite: { membershipId: '01a1e4a2-0000-7000-8000-000000000001', token: 'TOKEN_abc-123', days: 7 },
  password_reset: { token: 'TOKEN_reset', minutes: 30 },
  password_changed: {},
  admin_promoted: {},
  grade_released: {
    course: 'Physics I',
    item: 'Lab 3',
    kind: 'assignment',
    hasFeedback: true,
    link: '/offerings/o/items/i/assignment',
  },
  due_reminder: {
    course: 'Physics I',
    item: 'Lab 3',
    hours: 24,
    dueAt: '2026-11-17T12:30:00Z',
    link: '/offerings/o/items/i/assignment',
  },
  quiz_opens: {
    course: 'Physics I',
    item: 'Quiz 2',
    hours: 1,
    at: '2026-11-17T04:30:00Z',
    link: '/offerings/o/items/q',
  },
  quiz_closes: {
    course: 'Physics I',
    item: 'Quiz 2',
    hours: 24,
    at: '2026-11-18T04:30:00Z',
    link: '/offerings/o/items/q',
  },
  extension_granted: { course: 'Physics I', item: 'Lab 3', link: '/offerings/o/items/i' },
  erasure_request_received: { link: '/privacy/erasure' },
  erasure_request_approved: { days: 7, link: '/me/data' },
  erasure_request_rejected: { link: '/me/data' },
  erasure_request_cancelled: { link: '/me/data' },
  erasure_request_expired: { link: '/me/data' },
  accommodation_updated: { course: 'Physics I', item: 'Quiz 2', link: '/offerings/o/items/q' },
  content_digest: {
    course: 'Physics I',
    count: 7,
    titles: ['Week 4 slides', 'Reading', 'Video: optics', 'Notes', 'Lab sheet'],
    link: '/offerings/o',
  },
  grading_digest: {
    total: 12,
    courses: [
      { course: 'Physics I', count: 9 },
      { course: 'Physics II', count: 3 },
    ],
    link: '/teaching',
  },
  atrisk_weekly: { total: 4, courses: [{ course: 'Physics I', count: 4 }], link: '/teaching' },
  gradebook_submitted: { course: 'Physics I', version: 2, link: '/gradebooks' },
  gradebook_returned: { course: 'Physics I', version: 2, link: '/offerings/o/gradebook' },
  gradebook_approved: { course: 'Physics I', version: 2, link: '/offerings/o/gradebook' },
  video_ready: { course: 'Physics I', name: 'lecture-4.mp4', link: '/offerings/o/build' },
  video_failed: { course: 'Physics I', name: 'lecture-4.mov', link: '/offerings/o/build' },
  import_finished: {
    fileName: 'students.csv',
    status: 'completed_with_errors',
    processed: 480,
    failed: 20,
    link: '/imports/x',
  },
  course_health_weekly: { count: 3, link: '/college-dashboard' },
  usage_closed: { month: '2026-10-01', colleges: 14, link: '/usage' },
};

describe('templates', () => {
  it('there is a sample for every template', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...TEMPLATE_NAMES].sort());
  });

  for (const name of Object.keys(SAMPLE)) {
    it(`${name}: HTML + text snapshot`, () => {
      const security = ['invite', 'password_reset', 'password_changed', 'admin_promoted'].includes(
        name,
      );
      const platform = name === 'usage_closed';
      const out = render(
        name,
        SAMPLE[name],
        ctx({
          category: security ? 'security' : platform ? 'admin' : 'learning_grades',
          unsubscribeUrl: security || platform ? null : ctx().unsubscribeUrl,
          ...(platform ? { college: null, origin: 'https://admin.jcs-ilearn.example' } : {}),
        }),
      );
      expect(out.subject).not.toMatch(/[\r\n]/);
      expect(out.html.startsWith('<!doctype html>')).toBe(true);
      // every link points at the college's (or the admin) site
      for (const m of out.html.matchAll(/href="([^"]+)"/g)) {
        expect(m[1]).toMatch(/^https:\/\/(stjosephs|admin)\.jcs-ilearn\.example\//);
      }
      if (security) expect(out.text).toContain('It cannot be switched off.');
      else if (!platform) expect(out.text).toContain('Stop emails about grades and results:');
      expect(out).toMatchSnapshot();
    });
  }

  it('escapes every user-provided value in HTML and strips line breaks from the subject', () => {
    const out = render(
      'grade_released',
      {
        course: HOSTILE,
        item: `Lab\r\nBcc: x@evil.test`,
        kind: 'assignment',
        hasFeedback: false,
        link: '/offerings/o',
      },
      ctx({ college: { name: `<img src=x onerror=alert(1)>`, color: '#1d4ed8' } }),
    );
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;',
    );
    expect(out.subject).toBe('Your work on Lab Bcc: x@evil.test has been returned');
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it('refuses params a template does not declare: a mark, feedback or a reason cannot reach an email', () => {
    expect(() =>
      render('grade_released', { ...SAMPLE.grade_released, score: 87.5 }, ctx()),
    ).toThrow(TemplateError);
    expect(() =>
      render('extension_granted', { ...SAMPLE.extension_granted, reason: 'medical' }, ctx()),
    ).toThrow(/invalid params/);
    expect(() =>
      render('atrisk_weekly', { ...SAMPLE.atrisk_weekly, evidence: ['x'] }, ctx()),
    ).toThrow(TemplateError);
    expect(() => render('nope', {}, ctx())).toThrow(/unknown template/);
    // and no template declares such a field at all
    for (const schema of Object.values(TEMPLATE_PARAMS)) {
      const keys = Object.keys((schema as { properties: object }).properties);
      for (const k of keys) {
        if (k === 'hasFeedback') continue; // yes / no ("your instructor also left feedback"), never the text
        expect(k).not.toMatch(/score|mark|grade|feedback|reason|evidence|percent|points/i);
      }
    }
  });

  it('a link param must be a path inside the site (no absolute or javascript: URL)', () => {
    expect(() =>
      contentOf('video_ready', { ...SAMPLE.video_ready, link: 'https://evil.example/x' }, ctx()),
    ).toThrow(TemplateError);
    expect(() =>
      contentOf('video_ready', { ...SAMPLE.video_ready, link: 'javascript:alert(1)' }, ctx()),
    ).toThrow(TemplateError);
  });

  it('a digest names at most five titles and says how many more there are', () => {
    const out = render(
      'content_digest',
      SAMPLE.content_digest,
      ctx({ category: 'learning_content' }),
    );
    expect(out.text).toContain('- and 2 more');
    expect(out.subject).toBe('New in Physics I: 7 items');
  });
});

describe('html helpers', () => {
  it('escapeHtml / html`` / oneLine / displayName', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(html`<p>${'<b>'}</p>${html`<i>${'&'}</i>`}`.value).toBe('<p>&lt;b&gt;</p><i>&amp;</i>');
    expect(oneLine('a\r\nb\tc\u0000d')).toBe('a b c d');
    expect(oneLine('x'.repeat(300), 10)).toHaveLength(10);
    expect(displayName('Evil" <a@b.c>\\')).toBe('Evil a@b.c');
  });

  it('uses the college colour only where white text on it passes AA', () => {
    expect(brandColor('#1D4ED8')).toBe('#1d4ed8');
    expect(contrast('#1d4ed8', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(brandColor('#fde047')).toBe(NEUTRAL_BRAND); // yellow: white text would be unreadable
    expect(brandColor(null)).toBe(NEUTRAL_BRAND);
    expect(brandColor('red')).toBe(NEUTRAL_BRAND);
  });
});
