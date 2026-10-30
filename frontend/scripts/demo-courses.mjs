// Demo data for the course screens, shared by Lighthouse and the screenshots: one department, program, batch with
// two sections, a term, a course with a published offering of 6 modules x 5 items (text, a CSV file, a link, one
// locked entry and one hidden entry), an instructor and a learner who can sign in. Everything goes through the API of
// the real stack (the Host header names the college), the same way the E2E specs set up their data.

import { readFileSync } from 'node:fs';
import { request } from '@playwright/test';
import { MAIL_FILE } from './stack.mjs';

export const INSTRUCTOR = 'member@e2e-one.test'; // seeded member with the E2E password
export const LEARNER = 'lh.learner@e2e-one.test';
export const COURSE_TITLE = 'Introduction to Programming';

const doc = (...paragraphs) => ({
  type: 'doc',
  content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
});

async function api(webPort, email, password) {
  const host = `e2e-one.localhost:${webPort}`;
  const ctx = await request.newContext({
    baseURL: `http://127.0.0.1:${webPort}/api/`,
    extraHTTPHeaders: { host, origin: `http://${host}`, 'x-requested-with': 'lms' },
  });
  if (email) {
    const res = await ctx.post('auth/login', { data: { email, password } });
    if (!res.ok()) throw new Error(`demo sign-in as ${email} failed: ${res.status()}`);
  }
  return ctx;
}

const must = async (res, what) => {
  if (!res.ok()) throw new Error(`demo data (${what}) failed: ${res.status()} ${await res.text()}`);
  return res.json();
};

function inviteToken(email) {
  const lines = readFileSync(MAIL_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const mail = [...lines].reverse().find((m) => m.to === email);
  const link = mail && /(https?:\/\/\S+\?token=[A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!link) throw new Error(`no invitation mail for ${email}`);
  return new URL(link).searchParams.get('token');
}

/** Creates the demo course. Returns what the screens need. */
export async function seedCourseDemo({ webPort, password }) {
  const admin = await api(webPort, 'admin@e2e-one.test', password);
  // structure
  const depts = await must(await admin.get('departments?limit=100'), 'departments');
  let dept = depts.items.find((d) => d.code === 'CSE');
  if (!dept)
    dept = await must(
      await admin.post('departments', { data: { code: 'CSE', name: 'Computer Science' } }),
      'department',
    );
  const year = await must(
    await admin.post('academic-years', {
      data: { label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' },
    }),
    'year',
  );
  const term = await must(
    await admin.post('terms', {
      data: {
        academicYearId: year.id,
        name: 'Semester 1',
        startDate: '2026-06-01',
        endDate: '2026-11-30',
      },
    }),
    'term',
  );

  // people: the seeded member teaches, a new member learns
  const inv = await admin.post('auth/invites', {
    data: { email: LEARNER, role: 'member', displayName: 'Lena Learner' },
  });
  if (!inv.ok()) throw new Error(`demo invite failed: ${inv.status()}`);
  const anon = await api(webPort);
  await must(
    await anon.post('auth/invites/accept', { data: { token: inviteToken(LEARNER), password } }),
    'accept invite',
  );
  await anon.dispose();
  const members = await must(await admin.get('members?q=lh.learner'), 'members');
  const learnerId = members.items.find((m) => m.email === LEARNER)?.userId;
  const teacher = await must(await admin.get('members?q=member'), 'members');
  const teacherId = teacher.items.find((m) => m.email === INSTRUCTOR)?.userId;

  // course and offering
  const course = await must(
    await admin.post('courses', {
      data: { code: 'CS101', title: COURSE_TITLE, credits: 4, departmentId: dept.id },
    }),
    'course',
  );
  await must(
    await admin.post('courses', {
      data: { code: 'ELX200', title: 'Photography (elective)', credits: 2 },
    }),
    'elective',
  );
  const offering = await must(
    await admin.post('offerings', { data: { courseId: course.id, termId: term.id } }),
    'offering',
  );
  await must(
    await admin.post(`offerings/${offering.id}/participants`, {
      data: { userId: teacherId, participation: 'instructor' },
    }),
    'instructor',
  );
  await must(
    await admin.post(`offerings/${offering.id}/participants`, {
      data: { userId: learnerId, participation: 'learner' },
    }),
    'learner',
  );
  await admin.dispose();

  // content, built by the instructor
  const teach = await api(webPort, INSTRUCTOR, password);
  const topics = [
    'Getting started',
    'Variables and types',
    'Control flow',
    'Functions',
    'Collections',
    'Project',
  ];
  for (const [n, topic] of topics.entries()) {
    const mod = await must(
      await teach.post(`offerings/${offering.id}/modules`, {
        data: { title: `Week ${n + 1}: ${topic}` },
      }),
      'module',
    );
    await must(
      await teach.patch(`offerings/${offering.id}/modules/${mod.id}`, {
        data: { published: true },
      }),
      'show module',
    );
    for (let i = 1; i <= 4; i++) {
      await must(
        await teach.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
          data: {
            kind: 'text',
            title: `${topic}: reading ${i}`,
            body: doc(
              `Read this carefully before the lab.`,
              `Reading ${i} of ${topic.toLowerCase()} covers the core ideas with short examples.`,
            ),
            published: true,
          },
        }),
        'text item',
      );
    }
    await must(
      await teach.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
        data: {
          kind: 'link',
          title: `${topic}: further reading`,
          url: 'https://developer.mozilla.org/',
          published: true,
        },
      }),
      'link item',
    );
    if (n === 0) {
      await must(
        await teach.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
          data: {
            kind: 'link',
            title: 'Quiz opens next week',
            url: 'https://example.org/quiz',
            published: true,
            availableFrom: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          },
        }),
        'locked item',
      );
      await must(
        await teach.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
          data: { kind: 'link', title: 'Answer key (draft)', url: 'https://example.org/answers' },
        }),
        'hidden item',
      );
    }
  }
  await must(await teach.post(`offerings/${offering.id}/publish`), 'publish');
  await teach.dispose();
  return { offeringId: offering.id, learnerEmail: LEARNER, instructorEmail: INSTRUCTOR };
}
