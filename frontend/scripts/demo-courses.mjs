// Demo data for the course screens, shared by Lighthouse and the screenshots: one department, program, batch with
// two sections, a term, a course with a published offering of 6 modules x 5 items (text, a CSV file, a link, one
// locked entry and one hidden entry), an instructor and a learner who can sign in. Everything goes through the API of
// the real stack (the Host header names the college), the same way the E2E specs set up their data.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '@playwright/test';
import { FRONTEND, MAIL_FILE } from './stack.mjs';

export const INSTRUCTOR = 'member@e2e-one.test'; // seeded member with the E2E password
export const LEARNER = 'lh.learner@e2e-one.test';
export const COURSE_TITLE = 'Introduction to Programming';
/** two more learners for the class progress screens (the first one, LEARNER, does most of the work) */
export const MORE_LEARNERS = [
  ['lh.maya@e2e-one.test', 'Maya Mentee'],
  ['lh.noah@e2e-one.test', 'Noah Newcomer'],
];

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

/**
 * Uploads a short generated clip (a test pattern and a tone, made with the ffmpeg on the PATH) through the real
 * chunked upload, waits until the worker has transcoded it, and returns its id.
 */
async function uploadDemoVideo(teach, offeringId) {
  const dir = join(FRONTEND, '.e2e-tmp', 'video');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'demo.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=25:d=8',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=8',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);
  const bytes = readFileSync(file);
  const created = await must(
    await teach.post(`offerings/${offeringId}/videos`, {
      data: { fileName: 'demo.mp4', size: bytes.length },
    }),
    'video upload',
  );
  const chunk = created.upload.chunkBytes;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    await must(
      await teach.patch(`offerings/${offeringId}/videos/${created.video.id}/upload`, {
        data: bytes.subarray(offset, offset + chunk),
        headers: {
          'content-type': 'application/offset+octet-stream',
          'upload-offset': String(offset),
        },
      }),
      'video chunk',
    );
  }
  await must(
    await teach.post(`offerings/${offeringId}/videos/${created.video.id}/complete`),
    'video complete',
  );
  for (let i = 0; i < 200; i++) {
    const v = await must(
      await teach.get(`offerings/${offeringId}/videos/${created.video.id}`),
      'video status',
    );
    if (v.status === 'ready') return created.video.id;
    if (v.status === 'failed') throw new Error(`the demo video failed: ${v.error?.message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the demo video was not ready in time');
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
  for (const [email, displayName] of MORE_LEARNERS) {
    const invite = await admin.post('auth/invites', {
      data: { email, role: 'member', displayName },
    });
    if (!invite.ok()) throw new Error(`demo invite of ${email} failed: ${invite.status()}`);
    const who = await api(webPort);
    await must(
      await who.post('auth/invites/accept', { data: { token: inviteToken(email), password } }),
      'accept invite',
    );
    await who.dispose();
    const found = await must(await admin.get(`members?q=${email.split('@')[0]}`), 'members');
    await must(
      await admin.post(`offerings/${offering.id}/participants`, {
        data: {
          userId: found.items.find((m) => m.email === email)?.userId,
          participation: 'learner',
        },
      }),
      'more learners',
    );
  }
  await admin.dispose();

  // content, built by the instructor
  const teach = await api(webPort, INSTRUCTOR, password);
  let videoItemId = '';
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
      const videoId = await uploadDemoVideo(teach, offering.id);
      const video = await must(
        await teach.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
          data: {
            kind: 'video',
            title: 'Lecture: welcome to the course',
            videoId,
            published: true,
          },
        }),
        'video item',
      );
      videoItemId = video.id;
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

  // learning progress: the learner has done a good part of the course and half-watched the video; Maya a little
  const doSome = async (email, count, watch) => {
    const l = await api(webPort, email, password);
    const mine = await must(await l.get(`offerings/${offering.id}/progress`), 'progress');
    const todo = mine.items.filter((i) => i.status === 'not_started' && i.itemId !== videoItemId);
    for (const i of todo.slice(0, count)) {
      // text is marked by hand; a link completes when it is opened (the API says which with a 409)
      const done = await l.post(`offerings/${offering.id}/items/${i.itemId}/progress/complete`);
      if (done.status() === 409) {
        await must(
          await l.post(`offerings/${offering.id}/items/${i.itemId}/progress/viewed`),
          'viewed',
        );
      } else {
        await must(done, 'complete');
      }
    }
    if (watch) {
      const item = await must(await l.get(`offerings/${offering.id}/items/${videoItemId}`), 'item');
      await must(
        await l.post(`offerings/${offering.id}/items/${videoItemId}/progress/heartbeat`, {
          data: {
            videoId: item.video.id,
            streamId: '0b000000-0000-7000-8000-00000000000a',
            seq: 1,
            ranges: [[0, 4]],
            position: 4,
            rate: 1,
          },
        }),
        'heartbeat',
      );
    }
    await l.dispose();
  };
  await doSome(LEARNER, 14, true);
  await doSome(MORE_LEARNERS[0][0], 5, false);

  // assessments: a bank of 20 questions, an exam the learner has STARTED (the exam screen) and a quiz the learner has
  // HANDED IN with the results shown at once (the result screen)
  const teach2 = await api(webPort, INSTRUCTOR, password);
  const mod = await must(
    await teach2.post(`offerings/${offering.id}/modules`, { data: { title: 'Assessments' } }),
    'assessment module',
  );
  await must(
    await teach2.patch(`offerings/${offering.id}/modules/${mod.id}`, { data: { published: true } }),
    'show assessment module',
  );
  const questionIds = [];
  for (let n = 1; n <= 20; n++) {
    const q = await must(
      await teach2.post(`courses/${course.id}/questions`, {
        data: {
          type: n % 5 === 0 ? 'multiple_choice' : 'single_choice',
          difficulty: n % 3 === 0 ? 'hard' : 'easy',
          stem: doc(`Question ${n}: which statement about ${topics[n % topics.length]} is true?`),
          options: [
            { text: doc('The first statement'), correct: true },
            { text: doc('The second statement'), correct: n % 5 === 0 },
            { text: doc('The third statement'), correct: false },
            { text: doc('The fourth statement'), correct: false },
          ],
          tags: ['demo'],
        },
      }),
      'question',
    );
    questionIds.push(q.id);
  }
  const makeAssessment = async (title, settings) => {
    const item = await must(
      await teach2.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
        data: { kind: 'assessment', title, published: true },
      }),
      'assessment item',
    );
    await must(
      await teach2.put(`offerings/${offering.id}/items/${item.id}/assessment`, { data: settings }),
      'settings',
    );
    await must(
      await teach2.put(`offerings/${offering.id}/items/${item.id}/assessment/slots`, {
        data: {
          slots: questionIds.map((questionId) => ({ kind: 'fixed', questionId, points: 1 })),
        },
      }),
      'slots',
    );
    return item.id;
  };
  const examItemId = await makeAssessment('Midterm exam', {
    kind: 'exam',
    timeLimitMinutes: 90,
    attemptsAllowed: 2,
    shuffleQuestions: true,
    shuffleOptions: true,
    resultsVisibility: 'immediate',
    answersVisibility: 'never',
  });
  const quizItemId = await makeAssessment('Quick quiz', {
    kind: 'practice',
    attemptsAllowed: 3,
    resultsVisibility: 'immediate',
    answersVisibility: 'after_release',
  });
  await teach2.dispose();
  const learner = await api(webPort, LEARNER, password);
  const exam = await must(
    await learner.post(`offerings/${offering.id}/items/${examItemId}/attempts`, { data: {} }),
    'start exam',
  );
  const quiz = await must(
    await learner.post(`offerings/${offering.id}/items/${quizItemId}/attempts`, { data: {} }),
    'start quiz',
  );
  const paper = await must(
    await learner.get(`offerings/${offering.id}/attempts/${quiz.attemptId}`),
    'quiz paper',
  );
  await must(
    await learner.put(`offerings/${offering.id}/attempts/${quiz.attemptId}/answers`, {
      data: {
        answers: paper.questions.slice(0, 14).map((q, i) => ({
          position: q.position,
          answer: { o: [q.options[0].id] },
          rev: 1,
          at: Date.now() + i,
        })),
        events: [],
      },
    }),
    'quiz answers',
  );
  await must(
    await learner.post(`offerings/${offering.id}/attempts/${quiz.attemptId}/submit`, { data: {} }),
    'submit quiz',
  );
  await learner.dispose();

  // an assignment: the instructions, a PDF from the instructor, a rubric, a due date in three days with late work accepted
  // for nine; the learners HAND IN (one a PDF, the others text) so the learner page and the grading view are full
  const pdfBytes = (label) =>
    Buffer.from(`%PDF-1.4\n1 0 obj\n<<>>\nendobj\n% ${label}\ntrailer\n<<>>\n%%EOF\n`);
  const teach3 = await api(webPort, INSTRUCTOR, password);
  const put = async (client, target, bytes) => {
    const r = await client.put(target.upload.url, {
      data: bytes,
      headers: { ...target.upload.headers, 'content-length': String(bytes.length) },
    });
    if (!r.ok()) throw new Error(`demo upload failed: ${r.status()}`);
  };
  const assignment = await must(
    await teach3.post(`offerings/${offering.id}/modules/${mod.id}/items`, {
      data: { kind: 'assignment', title: 'Term essay', published: true },
    }),
    'assignment item',
  );
  const A = `offerings/${offering.id}/items/${assignment.id}/assignment`;
  const day = 86_400_000;
  await must(
    await teach3.put(A, {
      data: {
        instructions: doc(
          'Write a short essay (about 500 words) on one of the topics of the course.',
          'Cite at least two sources. Hand in a PDF, or paste the text.',
        ),
        dueAt: new Date(Date.now() + 3 * day).toISOString(),
        latePolicy: 'allowed',
        lateCutoffAt: new Date(Date.now() + 9 * day).toISOString(),
        penaltyKind: 'per_day',
        penaltyValue: 10,
        penaltyCap: 30,
        maxPoints: 50,
        passingScore: 40,
        allowText: true,
      },
    }),
    'assignment settings',
  );
  const rubric = await must(
    await teach3.post(`courses/${course.id}/rubrics`, {
      data: {
        title: 'Essay rubric',
        criteria: [
          {
            title: 'Argument',
            levels: [
              { title: 'Unclear', points: 0 },
              { title: 'Clear', points: 10 },
              { title: 'Convincing', points: 20 },
            ],
          },
          {
            title: 'Sources',
            levels: [
              { title: 'None', points: 0 },
              { title: 'Some', points: 5 },
              { title: 'Well chosen', points: 10 },
            ],
          },
        ],
      },
    }),
    'rubric',
  );
  await must(await teach3.put(`${A}/rubric`, { data: { rubricId: rubric.id } }), 'attach rubric');
  const brief = await must(
    await teach3.post(`offerings/${offering.id}/files`, {
      data: { name: 'essay-brief.pdf', size: pdfBytes('brief').length },
    }),
    'brief upload',
  );
  await put(teach3, brief, pdfBytes('brief'));
  await must(await teach3.post(`files/${brief.file.id}/confirm`), 'brief confirm');
  await must(
    await teach3.put(`${A}/attachments`, { data: { fileIds: [brief.file.id] } }),
    'attachments',
  );
  const handIn = async (email, withFile, text) => {
    const l = await api(webPort, email, password);
    const ids = [];
    if (withFile) {
      const bytes = pdfBytes(`work of ${email}`);
      const up = await must(
        await l.post(`${A}/files`, { data: { name: 'my-essay.pdf', size: bytes.length } }),
        'hand-in upload',
      );
      await put(l, up, bytes);
      await must(await l.post(`${A}/files/${up.fileId}/confirm`), 'hand-in confirm');
      ids.push(up.fileId);
    }
    await must(
      await l.post(`${A}/submissions`, {
        data: { requestKey: crypto.randomUUID(), fileIds: ids, ...(text ? { text } : {}) },
      }),
      'hand in',
    );
    await l.dispose();
  };
  await handIn(LEARNER, true, 'Here is my essay on loops and recursion.');
  for (const [email] of MORE_LEARNERS)
    await handIn(email, false, `Essay of ${email}: a text hand-in.`);
  const queue = await must(await teach3.get(`${A}/grading/queue?limit=10`), 'grading queue');
  const gradingLearnerKey = queue.items[0].learnerKey;
  await teach3.dispose();

  // ---- the gradebook (step 11): categories, items, a scale, marks of three learners, a submitted (not approved) gradebook
  const gradeAdmin = await api(webPort, 'admin@e2e-one.test', password);
  const scale = await must(
    await gradeAdmin.post('grade-scales', {
      data: {
        name: 'Demo scale',
        bands: [
          { minPercent: 0, label: 'RA', isPass: false },
          { minPercent: 50, label: 'C', isPass: true },
          { minPercent: 60, label: 'B', isPass: true },
          { minPercent: 70, label: 'B+', isPass: true },
          { minPercent: 80, label: 'A', isPass: true },
          { minPercent: 90, label: 'A+', isPass: true },
        ],
      },
    }),
    'grade scale',
  );
  await gradeAdmin.dispose();
  const gt = await api(webPort, INSTRUCTOR, password);
  const GB = `offerings/${offering.id}/gradebook`;
  const first = await must(await gt.get(GB), 'gradebook');
  const withCats = await must(
    await gt.put(`${GB}/categories`, {
      data: {
        categories: [
          {
            id: first.categories[0].id,
            name: 'Coursework',
            weight: 60,
            dropLowest: 0,
            missingPolicy: 'exclude',
          },
          { name: 'Exams', weight: 40, dropLowest: 1, missingPolicy: 'zero_after_due' },
        ],
      },
    }),
    'gradebook categories',
  );
  const [coursework, exams] = withCats.categories.map((c) => c.id);
  await must(
    await gt.put(`${GB}/items`, {
      data: {
        items: [
          {
            source: 'manual',
            title: 'Lab marks',
            categoryId: coursework,
            points: 20,
            extraCredit: false,
            released: true,
          },
          {
            source: 'assignment',
            contentItemId: assignment.id,
            categoryId: coursework,
            points: 100,
            extraCredit: false,
          },
          {
            source: 'assessment',
            contentItemId: quizItemId,
            categoryId: exams,
            points: 10,
            extraCredit: false,
          },
          {
            source: 'assessment',
            contentItemId: examItemId,
            categoryId: exams,
            points: 20,
            extraCredit: false,
          },
        ],
      },
    }),
    'gradebook items',
  );
  await must(
    await gt.patch(`${GB}/settings`, { data: { weighted: true, outOf: 40, scaleId: scale.id } }),
    'gradebook settings',
  );
  const grid = await must(await gt.get(`${GB}/grid`), 'gradebook grid');
  const lab = (await must(await gt.get(GB), 'gradebook')).items.find(
    (i) => i.title === 'Lab marks',
  );
  await must(
    await gt.put(`${GB}/marks`, {
      data: {
        cells: grid.rows.map((r, i) => ({
          itemId: lab.id,
          participantId: r.participantId,
          points: String(12 + ((i * 3) % 8)),
        })),
      },
    }),
    'gradebook marks',
  );
  await gt.dispose();
  return {
    assignmentItemId: assignment.id,
    gradingLearnerKey,
    offeringId: offering.id,
    courseId: course.id,
    videoItemId,
    examItemId,
    quizItemId,
    examAttemptId: exam.attemptId,
    resultAttemptId: quiz.attemptId,
    learnerEmail: LEARNER,
    instructorEmail: INSTRUCTOR,
  };
}
