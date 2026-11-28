import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { createPasswordHasher } from '../core/password';
import { base32Decode, hotp, totpStep } from '../core/totp';
import { newId } from '../core/uuid';
import {
  ADMIN,
  ASSISTANT,
  COLLEGE,
  COURSES,
  type DemoCourse,
  INSTRUCTORS,
  LEARNER_NAMES,
  localPart,
} from './data';
import {
  type Browser,
  type DemoOptions,
  type DemoRuntime,
  type DemoState,
  openOwner,
  openRuntime,
  stateDir,
  writeState,
} from './runtime';
import { assertFfmpeg, placeholderClip, uploadLecture } from './video';

// `pnpm demo:seed`: one demo college with people, two courses and enough history that every dashboard has something to show.
//
// What the OWNER connection inserts: the college, its accounts (one shared password), and afterwards the AGEING of dates, so
// that "three weeks ago" exists in a college that is five minutes old. Everything a person does goes through the real routes
// as that person: the administrator's two-step enrolment, course building, lecture upload, quizzes, hand-ins, grading,
// release and the gradebook.

export interface SeedOptions extends DemoOptions {
  /** every account gets it; 12 characters or more. Generated when absent. */
  password?: string | undefined;
}

export interface SeedResult {
  state: DemoState;
  stateFile: string;
  /** five new students, for the bulk import of the walkthrough */
  importFile: string;
  url: string;
  emails: { admin: string; instructors: string[]; assistant: string; learner: string };
  tenantId: string;
}

/** What a learner is like, by their place in the list (0 = the one the walkthrough signs in as). */
export type Persona = 'demo' | 'steady' | 'behind' | 'low' | 'absent';
export const personaOf = (index: number): Persona => {
  if (index === 0) return 'demo';
  if (index >= 26) return 'absent';
  if (index >= 23) return 'low';
  if (index >= 19) return 'behind';
  return 'steady';
};

const DAY = 86_400_000;
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY).toISOString();

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
});

/** Every text of a question or option, whatever shape it is wrapped in. */
function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, v]) => (key === 'text' && typeof v === 'string' ? v : textOf(v)))
      .join('');
  }
  return '';
}

/** A one-page PDF that really opens, for the hand-ins an instructor previews. */
function pdf(title: string, line: string): Buffer {
  const safe = (s: string) => s.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 72 740 Td (${safe(title)}) Tj /F1 12 Tf 0 -32 Td (${safe(line)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

interface Person {
  userId: string;
  email: string;
  name: string;
}
interface People {
  admin: Person;
  instructors: Person[];
  assistant: Person;
  learners: Person[];
}

/** The college and its accounts, in one transaction. */
async function insertPeople(
  owner: pg.Client,
  slug: string,
  tenantId: string,
  password: string,
): Promise<People> {
  const person = (local: string, name: string): Person => ({
    userId: newId(),
    email: `${local}@${slug}.example`,
    name,
  });
  const people: People = {
    admin: person(ADMIN.local, ADMIN.name),
    instructors: INSTRUCTORS.map((p) => person(p.local, p.name)),
    assistant: person(ASSISTANT.local, ASSISTANT.name),
    learners: LEARNER_NAMES.map((name) => person(localPart(name), name)),
  };
  const all = [people.admin, ...people.instructors, people.assistant, ...people.learners];
  const hash = await createPasswordHasher({ concurrency: 1 }).hash(password);
  await owner.query('BEGIN');
  try {
    await owner.query('INSERT INTO lms.tenants (id, slug, name) VALUES ($1, $2, $3)', [
      tenantId,
      slug,
      COLLEGE.name,
    ]);
    await owner.query(
      `INSERT INTO lms.users (id, email, display_name)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])`,
      [all.map((p) => p.userId), all.map((p) => p.email), all.map((p) => p.name)],
    );
    await owner.query(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
       SELECT lms.uuid_v7(), $2, u.id,
              CASE WHEN u.id = $3 THEN 'institution_admin' ELSE 'member' END::lms.membership_role, 'active'
         FROM unnest($1::uuid[]) AS u (id)`,
      [all.map((p) => p.userId), tenantId, people.admin.userId],
    );
    await owner.query(
      `INSERT INTO lms.user_credentials (user_id, password_hash)
       SELECT u.id, $2 FROM unnest($1::uuid[]) AS u (id)`,
      [all.map((p) => p.userId), hash],
    );
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return people;
}

/**
 * The administrator's two-step sign-in, through the product's own enrolment (password -> emailed link -> link and password ->
 * first code). Enforcement stays on; the secret is shown to whoever runs the seed.
 */
async function enrolAdmin(
  runtime: DemoRuntime,
  tenantId: string,
  admin: Browser,
  email: string,
  password: string,
) {
  const first = await admin.signIn(email, password);
  if (first.status !== 202 || first.json.step !== 'enrol_email') {
    throw new Error(
      'the administrator was not asked to set up two-step sign-in: is MFA_ENFORCEMENT=off in your environment? The demo needs it on (the default).',
    );
  }
  await runtime.drain(tenantId, ['email.send']);
  const mail = [...runtime.mail.sent].reverse().find((m) => m.to === email);
  const token = mail && /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) {
    throw new Error(
      'the set-up link was not sent here: stop the running worker (pnpm dev) and run pnpm demo:reset',
    );
  }
  const started = await admin.post('/auth/mfa/enrol/start', { token, password });
  const done = await admin.post('/auth/mfa/enrol/confirm', {
    code: hotp(base32Decode(started.secret), totpStep(new Date())),
  });
  return { secret: started.secret as string, recoveryCodes: done.recoveryCodes as string[] };
}

const NEW_STUDENTS = [
  'Anirudh Mohan',
  'Fathima Beevi',
  'Kiran Shenoy',
  'Lavanya Mani',
  'Rahul Pandey',
];

/** Five students who are not in the college yet, for the bulk import of the walkthrough. */
function writeImportFile(
  env: Record<string, string | undefined>,
  slug: string,
  batch: string,
  year: number,
): string {
  mkdirSync(stateDir(env), { recursive: true });
  const file = join(stateDir(env), `${slug}-new-students.csv`);
  const rows = NEW_STUDENTS.map(
    (name, i) =>
      `${localPart(name)}@${slug}.example,${name},NCE${year % 100}CS${101 + i},CSE,BE-CSE,${batch},${i % 2 ? 'B' : 'A'}`,
  );
  writeFileSync(
    file,
    `email,full_name,register_number,department_code,program_code,batch,section\r\n${rows.join('\r\n')}\r\n`,
  );
  return file;
}

/** Departments, a programme, a batch with two sections, the current term and every member's profile. */
async function academics(owner: pg.Client, admin: Browser, people: People) {
  await admin.patch('/tenant/branding', {
    displayName: COLLEGE.name,
    primaryColor: COLLEGE.primaryColor,
  });
  const cse = await admin.post('/departments', {
    code: 'CSE',
    name: 'Computer Science and Engineering',
  });
  const mech = await admin.post('/departments', { code: 'MECH', name: 'Mechanical Engineering' });
  const program = await admin.post('/programs', {
    departmentId: cse.id,
    code: 'BE-CSE',
    name: 'B.E. Computer Science and Engineering',
    durationYears: 4,
  });
  // the college's days, not the database session's
  const { rows } = await owner.query<{
    y: number;
    start: string;
    finish: string;
    ys: string;
    yf: string;
  }>(
    `SELECT extract(year FROM d)::int AS y,
            to_char(d - 70, 'YYYY-MM-DD') AS start, to_char(d + 110, 'YYYY-MM-DD') AS finish,
            to_char(d - 120, 'YYYY-MM-DD') AS ys, to_char(d + 240, 'YYYY-MM-DD') AS yf
       FROM (SELECT lms.local_day(now(), 'Asia/Kolkata') AS d) t`,
  );
  const when = rows[0] as (typeof rows)[number];
  const batch = await admin.post('/batches', {
    programId: program.id,
    admissionYear: when.y - 1,
    graduationYear: when.y + 3,
  });
  const sections = [
    await admin.post('/sections', { batchId: batch.id, code: 'A' }),
    await admin.post('/sections', { batchId: batch.id, code: 'B' }),
  ];
  const year = await admin.post('/academic-years', {
    label: `${when.y}-${String((when.y + 1) % 100).padStart(2, '0')}`,
    startDate: when.ys,
    endDate: when.yf,
  });
  const term = await admin.post('/terms', {
    academicYearId: year.id,
    name: 'Current semester',
    startDate: when.start,
    endDate: when.finish,
  });
  for (const [i, learner] of people.learners.entries()) {
    await admin.patch(`/members/${learner.userId}/profile`, {
      profileType: 'student',
      registerNumber: `NCE${String((when.y - 1) % 100)}CS${String(i + 1).padStart(3, '0')}`,
      batchId: batch.id,
      sectionId: sections[i % 2].id,
    });
  }
  for (const [i, staff] of [...people.instructors, people.assistant].entries()) {
    await admin.patch(`/members/${staff.userId}/profile`, {
      profileType: 'faculty',
      employeeId: `NCE-F${String(i + 11).padStart(3, '0')}`,
      departmentId: i === 1 ? mech.id : cse.id,
    });
  }
  const scale = await admin.post('/grade-scales', {
    name: 'College grade scale',
    bands: [
      { minPercent: 0, label: 'RA', isPass: false },
      { minPercent: 50, label: 'C', isPass: true },
      { minPercent: 60, label: 'B', isPass: true },
      { minPercent: 70, label: 'B+', isPass: true },
      { minPercent: 80, label: 'A', isPass: true },
      { minPercent: 90, label: 'O', isPass: true },
    ],
  });
  return {
    departments: [cse.id as string, mech.id as string],
    termId: term.id as string,
    scaleId: scale.id as string,
    batch: `${when.y - 1}-${when.y + 3}`,
    admissionYear: when.y - 1,
  };
}

interface BuiltCourse {
  spec: DemoCourse;
  offeringId: string;
  courseId: string;
  teacher: Browser;
  /** items of the first unit (the ones that become weeks old) */
  readings: { id: string; kind: 'text' | 'link' }[];
  oldModuleId: string;
  oldVideoItemId: string | null;
  quizItemId: string;
  timedQuizItemId: string | null;
  assignmentItemId: string;
  openAssignmentItemId: string | null;
}

async function buildCourse(args: {
  runtime: DemoRuntime;
  tenantId: string;
  spec: DemoCourse;
  admin: Browser;
  teacher: Browser;
  people: People;
  departmentId: string;
  termId: string;
  videoFile: string;
  log: (m: string) => void;
}): Promise<BuiltCourse> {
  const { runtime, tenantId, spec, admin, teacher, people } = args;
  const course = await admin.post('/courses', {
    code: spec.code,
    title: spec.title,
    credits: spec.credits,
    departmentId: args.departmentId,
  });
  const offering = await admin.post('/offerings', { courseId: course.id, termId: args.termId });
  const O = `/offerings/${offering.id}`;
  const add = (userId: string, participation: string) =>
    admin.post(`${O}/participants`, { userId, participation });
  await add(people.instructors[spec.instructor]?.userId as string, 'instructor');
  if (spec.withAssistant) await add(people.assistant.userId, 'assistant');
  for (const learner of people.learners) await add(learner.userId, 'learner');

  const readings: BuiltCourse['readings'] = [];
  const modules: string[] = [];
  let oldVideoItemId: string | null = null;
  for (const [n, unit] of spec.modules.entries()) {
    const module = await teacher.post(`${O}/modules`, { title: unit.title });
    await teacher.patch(`${O}/modules/${module.id}`, { published: true });
    modules.push(module.id);
    const item = (body: Record<string, unknown>) =>
      teacher.post(`${O}/modules/${module.id}/items`, { published: true, ...body });
    if (unit.lecture) {
      args.log(`  ${spec.code}: ${unit.lecture} (placeholder clip)`);
      const videoId = await uploadLecture(runtime, tenantId, teacher, offering.id, args.videoFile);
      const video = await item({ kind: 'video', title: unit.lecture, videoId });
      if (n === 0) oldVideoItemId = video.id;
    }
    for (const reading of unit.readings) {
      const made = await item({
        kind: 'text',
        title: reading.title,
        body: doc(...reading.paragraphs),
      });
      if (n === 0) readings.push({ id: made.id, kind: 'text' });
    }
    if (unit.link) {
      const made = await item({ kind: 'link', ...unit.link });
      if (n === 0) readings.push({ id: made.id, kind: 'link' });
    }
  }

  // ---- the question bank and the quizzes
  const questionIds: string[] = [];
  for (const q of spec.questions) {
    const made = await teacher.post(`/courses/${course.id}/questions`, {
      type: 'single_choice',
      difficulty: 'easy',
      stem: doc(q.stem),
      options: q.options.map((text, i) => ({ text: doc(text), correct: i === 0 })),
      tags: [spec.code.toLowerCase()],
    });
    questionIds.push(made.id);
  }
  const quiz = async (moduleId: string, title: string, settings: Record<string, unknown>) => {
    const made = await teacher.post(`${O}/modules/${moduleId}/items`, {
      kind: 'assessment',
      title,
      published: true,
    });
    await teacher.put(`${O}/items/${made.id}/assessment`, settings);
    await teacher.put(`${O}/items/${made.id}/assessment/slots`, {
      slots: questionIds.map((questionId) => ({ kind: 'fixed', questionId, points: 1 })),
    });
    return made.id as string;
  };
  const quizItemId = await quiz(modules[0] as string, 'Unit test 1', {
    kind: 'exam',
    closesAt: iso(5),
    timeLimitMinutes: 30,
    attemptsAllowed: 1,
    shuffleQuestions: true,
    shuffleOptions: true,
    resultsVisibility: 'immediate',
    answersVisibility: 'never',
  });
  const timedQuizItemId = spec.withAssistant
    ? await quiz(modules[1] as string, 'Timed quiz: stacks and queues', {
        kind: 'exam',
        timeLimitMinutes: 10,
        attemptsAllowed: 5,
        shuffleQuestions: true,
        shuffleOptions: true,
        resultsVisibility: 'immediate',
        answersVisibility: 'never',
      })
    : null;

  // ---- the assignments and the rubric
  const rubric = await teacher.post(`/courses/${course.id}/rubrics`, {
    title: `${spec.title}: written work`,
    criteria: [
      {
        title: 'Correctness',
        levels: [
          { title: 'Mostly wrong', points: 5 },
          { title: 'Partly right', points: 18 },
          { title: 'Correct', points: 30 },
        ],
      },
      {
        title: 'Explanation',
        levels: [
          { title: 'Missing', points: 2 },
          { title: 'Brief', points: 8 },
          { title: 'Clear and complete', points: 20 },
        ],
      },
    ],
  });
  const assignment = async (moduleId: string, title: string, task: string, dueInDays: number) => {
    const made = await teacher.post(`${O}/modules/${moduleId}/items`, {
      kind: 'assignment',
      title,
      published: true,
    });
    const A = `${O}/items/${made.id}/assignment`;
    await teacher.put(A, {
      instructions: doc(task, 'Hand in a PDF, or type your answer.'),
      dueAt: iso(dueInDays),
      latePolicy: 'none',
      maxPoints: 50,
      passingScore: 40,
      allowFile: true,
      allowText: true,
      maxFiles: 2,
      resubmissionAllowed: true,
    });
    await teacher.put(`${A}/rubric`, { rubricId: rubric.id });
    return made.id as string;
  };
  const dataStructures = spec.code === 'CS201';
  const assignmentItemId = await assignment(
    modules[0] as string,
    dataStructures ? 'Assignment 1: linked list operations' : 'Assignment 1: free body diagrams',
    dataStructures
      ? 'Describe how you would delete a node from a singly linked list, with the special cases.'
      : 'Draw and explain the free body diagram of a ladder resting against a smooth wall.',
    dataStructures ? 3 : 6,
  );
  const openAssignmentItemId = dataStructures
    ? await assignment(
        modules[1] as string,
        'Assignment 2: a queue from two stacks',
        'Explain how to build a queue using two stacks and what each operation costs.',
        7,
      )
    : null;

  await teacher.post(`${O}/publish`);
  return {
    spec,
    offeringId: offering.id,
    courseId: course.id,
    teacher,
    readings,
    oldModuleId: modules[0] as string,
    oldVideoItemId,
    quizItemId,
    timedQuizItemId,
    assignmentItemId,
    openAssignmentItemId,
  };
}

/** How many of the quiz's questions a learner gets right. */
const rightAnswers = (persona: Persona, index: number, total: number): number => {
  if (persona === 'low') return 1;
  if (persona === 'behind') return 0;
  if (persona === 'demo') return total - 1;
  return Math.max(Math.ceil(total / 2), total - (index % 4));
};

async function takeQuiz(learner: Browser, course: BuiltCourse, right: number) {
  const O = `/offerings/${course.offeringId}`;
  const attempt = await learner.post(`${O}/items/${course.quizItemId}/attempts`);
  const paper = await learner.get(`${O}/attempts/${attempt.attemptId}`);
  const correct = new Map(course.spec.questions.map((q) => [q.stem, q.options[0]]));
  const answers = paper.questions.map(
    (q: { position: number; options: { id: string }[] }, n: number) => {
      const { options, ...rest } = q;
      const want = correct.get(
        [...correct.keys()].find((stem) => textOf(rest).includes(stem)) ?? '',
      );
      const isRight = (o: unknown) => textOf(o) === want;
      const choice = n < right ? options.find(isRight) : options.find((o) => !isRight(o));
      return {
        position: q.position,
        answer: { o: [choice?.id ?? options[0]?.id] },
        rev: 1,
        at: Date.now() + n,
      };
    },
  );
  await learner.put(`${O}/attempts/${attempt.attemptId}/answers`, { answers, events: [] });
  await learner.post(`${O}/attempts/${attempt.attemptId}/submit`);
}

async function handIn(learner: Browser, course: BuiltCourse, person: Person, withFile: boolean) {
  const A = `/offerings/${course.offeringId}/items/${course.assignmentItemId}/assignment`;
  const fileIds: string[] = [];
  if (withFile) {
    const bytes = pdf(`${course.spec.title}: assignment 1`, `Submitted by ${person.name}`);
    const up = await learner.post(`${A}/files`, { name: 'assignment-1.pdf', size: bytes.length });
    const target = new URL(up.upload.url, 'http://upload.local');
    const put = await learner.send('PUT', `${target.pathname}${target.search}`, bytes, {
      ...up.upload.headers,
      'content-length': String(bytes.length),
    });
    if (put.status >= 300) throw new Error(`file upload failed: ${put.status}`);
    await learner.post(`${A}/files/${up.fileId}/confirm`);
    fileIds.push(up.fileId);
  }
  await learner.post(`${A}/submissions`, {
    requestKey: randomUUID(),
    fileIds,
    text: 'My answer: I considered the empty case and the single element case first, then the general case.',
  });
}

/** What one learner has done so far in both courses. */
async function learnerHistory(
  runtime: DemoRuntime,
  person: Person,
  index: number,
  password: string,
  courses: BuiltCourse[],
) {
  const persona = personaOf(index);
  if (persona === 'absent') return;
  const learner = runtime.browser();
  await learner.signIn(person.email, password);
  for (const course of courses) {
    const O = `/offerings/${course.offeringId}`;
    // steady learners finish the first unit; those who are behind open one page
    const done = persona === 'behind' ? 1 : persona === 'low' ? 2 : course.readings.length;
    for (const item of course.readings.slice(0, done)) {
      const action = item.kind === 'link' ? 'viewed' : 'complete';
      await learner.post(`${O}/items/${item.id}/progress/${action}`);
    }
    if (course.oldVideoItemId && persona !== 'behind') {
      const item = await learner.get(`${O}/items/${course.oldVideoItemId}`);
      await learner.post(`${O}/items/${course.oldVideoItemId}/progress/heartbeat`, {
        videoId: item.video.id,
        streamId: randomUUID(),
        seq: 1,
        ranges: [[0, persona === 'low' ? 9 : 30]],
        position: persona === 'low' ? 9 : 30,
        rate: 1,
      });
    }
    if (persona === 'behind') continue;
    await takeQuiz(learner, course, rightAnswers(persona, index, course.spec.questions.length));
    await handIn(learner, course, person, index < 6);
  }
}

/**
 * Grades the hand-ins of Assignment 1. Data Structures: all of them, released. Engineering Mechanics: only the first six,
 * not released, so there is work waiting to be graded.
 */
async function grade(course: BuiltCourse, people: People) {
  const A = `/offerings/${course.offeringId}/items/${course.assignmentItemId}/assignment`;
  const queue = await course.teacher.get(`${A}/grading/queue?limit=100`);
  const handedIn = queue.items.filter((i: { status: string }) => i.status !== 'not_submitted');
  const mechanics = !course.spec.withAssistant;
  for (const [n, row] of (mechanics ? handedIn.slice(0, 6) : handedIn).entries()) {
    const detail = await course.teacher.get(`${A}/grading/learners/${row.learnerKey}`);
    const index = people.learners.findIndex((p) => p.name === detail.name);
    const level = personaOf(index) === 'low' ? 0 : index % 4 === 3 ? 1 : 2;
    const rubricSelection = Object.fromEntries(
      detail.rubric.criteria.map((c: { id: string; levels: { id: string }[] }) => [
        c.id,
        { levelId: c.levels[level]?.id },
      ]),
    );
    await course.teacher.put(`${A}/grading/learners/${row.learnerKey}/grade`, {
      submissionId: detail.submissions[0].id,
      rubricSelection,
      feedback: doc(
        level === 2
          ? 'Clear and well argued. Good handling of the special cases.'
          : `Number ${n + 1} in the pile: please explain your steps more fully next time.`,
      ),
    });
  }
  if (!mechanics) await course.teacher.post(`${A}/release`);
}

/** Categories, the quiz and the assignment as items, a manual column with marks, the college scale. */
async function gradebook(course: BuiltCourse, scaleId: string) {
  const G = `/offerings/${course.offeringId}/gradebook`;
  const first = await course.teacher.get(G);
  const saved = await course.teacher.put(`${G}/categories`, {
    categories: [
      {
        id: first.categories[0].id,
        name: 'Coursework',
        weight: 40,
        dropLowest: 0,
        missingPolicy: 'exclude',
      },
      { name: 'Tests', weight: 60, dropLowest: 0, missingPolicy: 'zero_after_due' },
    ],
  });
  const [coursework, tests] = saved.categories.map((c: { id: string }) => c.id);
  await course.teacher.put(`${G}/items`, {
    items: [
      {
        source: 'manual',
        title: 'Lab record',
        categoryId: coursework,
        points: 20,
        extraCredit: false,
        released: true,
      },
      {
        source: 'assignment',
        contentItemId: course.assignmentItemId,
        categoryId: coursework,
        points: 50,
        extraCredit: false,
      },
      {
        source: 'assessment',
        contentItemId: course.quizItemId,
        categoryId: tests,
        points: 50,
        extraCredit: false,
      },
    ],
  });
  await course.teacher.patch(`${G}/settings`, { weighted: true, outOf: 100, scaleId });
  const grid = await course.teacher.get(`${G}/grid`);
  const lab = (await course.teacher.get(G)).items.find(
    (i: { title: string }) => i.title === 'Lab record',
  );
  await course.teacher.put(`${G}/marks`, {
    cells: grid.rows.map((r: { participantId: string }, i: number) => ({
      itemId: lab.id,
      participantId: r.participantId,
      points: String(11 + ((i * 7) % 10)),
    })),
  });
}

/**
 * Makes the history old. Owner connection, this college only: the first unit and everything done in it move weeks into the
 * past, and the people get days of activity (none for the ones who never came, only old ones for those who fell behind).
 */
async function age(
  owner: pg.Client,
  tenantId: string,
  courses: BuiltCourse[],
  people: People,
): Promise<void> {
  const modules = courses.map((c) => c.oldModuleId);
  const quizzes = courses.map((c) => c.quizItemId);
  const assignments = courses.map((c) => c.assignmentItemId);
  const absent = people.learners.filter((_, i) => personaOf(i) === 'absent').map((p) => p.userId);
  const behind = people.learners.filter((_, i) => personaOf(i) === 'behind').map((p) => p.userId);
  const staff = [people.admin, ...people.instructors, people.assistant].map((p) => p.userId);
  await owner.query('BEGIN');
  try {
    const run = (sql: string, params: unknown[] = []) => owner.query(sql, [tenantId, ...params]);
    await run(
      `UPDATE lms.course_participants SET created_at = now() - interval '56 days' WHERE tenant_id = $1`,
    );
    await run(
      `UPDATE lms.content_modules SET created_at = now() - interval '50 days' WHERE tenant_id = $1 AND id = ANY($2)`,
      [modules],
    );
    await run(
      `UPDATE lms.content_items SET created_at = now() - interval '49 days' WHERE tenant_id = $1 AND module_id = ANY($2)`,
      [modules],
    );
    // the unit test closed five days ago, the first assignment was due six days ago; what was done, was done before that
    await run(
      `UPDATE lms.assessments SET closes_at = now() - interval '5 days' WHERE tenant_id = $1 AND item_id = ANY($2)`,
      [quizzes],
    );
    await run(
      `UPDATE lms.attempts SET started_at = started_at - interval '8 days', deadline_at = deadline_at - interval '8 days',
              submitted_at = submitted_at - interval '8 days', graded_at = graded_at - interval '8 days',
              released_at = released_at - interval '8 days'
        WHERE tenant_id = $1 AND assessment_item_id = ANY($2)`,
      [quizzes],
    );
    await run(
      `UPDATE lms.assignments SET due_at = now() - interval '6 days' WHERE tenant_id = $1 AND item_id = ANY($2)`,
      [assignments],
    );
    await run(
      `UPDATE lms.submissions SET submitted_at = submitted_at - interval '8 days'
        WHERE tenant_id = $1 AND assignment_item_id = ANY($2)`,
      [assignments],
    );
    // progress spread over the last ten days; those who fell behind last did something three weeks ago
    await run(
      `UPDATE lms.item_progress ip
          SET first_seen_at = t.at, last_activity_at = t.at,
              completed_at = CASE WHEN ip.completed_at IS NULL THEN NULL ELSE t.at END
         FROM (SELECT p.participant_id, p.item_id,
                      now() - make_interval(days => CASE WHEN m.user_id = ANY($2) THEN 21
                                                         ELSE 1 + abs(hashtext(p.participant_id::text || p.item_id::text)) % 10 END) AS at
                 FROM lms.item_progress p
                 JOIN lms.course_participants cp ON cp.tenant_id = p.tenant_id AND cp.id = p.participant_id
                 JOIN lms.tenant_memberships m ON m.tenant_id = cp.tenant_id AND m.id = cp.membership_id
                WHERE p.tenant_id = $1) t
        WHERE ip.tenant_id = $1 AND ip.participant_id = t.participant_id AND ip.item_id = t.item_id`,
      [behind],
    );
    // days of activity over the last 30 days, in the college's own days
    await run('DELETE FROM lms.member_activity_days WHERE tenant_id = $1');
    await run(
      `INSERT INTO lms.member_activity_days (tenant_id, user_id, day)
       SELECT $1, m.user_id, lms.local_day(now(), 'Asia/Kolkata') - d.n
         FROM lms.tenant_memberships m
        CROSS JOIN generate_series(0, 29) AS d (n)
        WHERE m.tenant_id = $1 AND NOT (m.user_id = ANY($2))
          AND (NOT (m.user_id = ANY($3)) OR d.n >= 21)
          AND (m.user_id = ANY($4) OR abs(hashtext(m.user_id::text || d.n::text)) % 5 < 3)`,
      [absent, behind, staff],
    );
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function seedDemo(opts: SeedOptions): Promise<SeedResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const password = opts.password ?? `Demo-${randomBytes(9).toString('base64url')}`;
  if (password.length < 12) throw new Error('the password needs 12 characters or more');

  const owner = await openOwner(opts); // the guard runs here, before anything is read or written
  let runtime: DemoRuntime | undefined;
  try {
    if ((await owner.query('SELECT 1 FROM lms.tenants WHERE slug = $1', [opts.slug])).rowCount) {
      throw new Error(
        `the college ${opts.slug} already exists: run pnpm demo:reset to remove and re-create it`,
      );
    }
    assertFfmpeg(env);
    const videoFile = placeholderClip(env);
    runtime = await openRuntime(opts);

    log(`> ${opts.slug}: people`);
    const tenantId = newId();
    const people = await insertPeople(owner, opts.slug, tenantId, password);

    log("> the administrator's two-step sign-in, academic structure");
    const admin = runtime.browser();
    const mfa = await enrolAdmin(runtime, tenantId, admin, people.admin.email, password);
    // written at once: whatever fails after this, the way back in is on disk (and demo:reset works)
    const state: DemoState = {
      slug: opts.slug,
      password,
      adminEmail: people.admin.email,
      adminTotpSecret: mfa.secret,
      adminRecoveryCodes: mfa.recoveryCodes,
    };
    const stateFile = writeState(env, state);
    const structure = await academics(owner, admin, people);
    const importFile = writeImportFile(env, opts.slug, structure.batch, structure.admissionYear);

    const teachers: Browser[] = [];
    for (const instructor of people.instructors) {
      const browser = runtime.browser();
      await browser.signIn(instructor.email, password);
      teachers.push(browser);
    }
    log('> courses, lectures, quizzes, assignments');
    const courses: BuiltCourse[] = [];
    for (const [n, spec] of COURSES.entries()) {
      courses.push(
        await buildCourse({
          runtime,
          tenantId,
          spec,
          admin,
          teacher: teachers[spec.instructor] as Browser,
          people,
          departmentId: structure.departments[n] as string,
          termId: structure.termId,
          videoFile,
          log,
        }),
      );
    }

    log('> what 30 learners have done: progress, quizzes, hand-ins');
    for (const [i, learner] of people.learners.entries()) {
      await learnerHistory(runtime, learner, i, password, courses);
    }

    log('> grading and gradebooks');
    for (const course of courses) await grade(course, people);
    for (const course of courses) await gradebook(course, structure.scaleId);

    log('> history, rollups, at-risk, notifications');
    await age(owner, tenantId, courses, people);
    // Data Structures waits for the administrator's approval; Engineering Mechanics stays a draft
    const [first] = courses;
    if (first) await first.teacher.post(`/offerings/${first.offeringId}/gradebook/submit`);
    // this college only (the scheduled jobs would walk every college of the database)
    await owner.query('SELECT lms.notify_scan_tenant($1, now())', [tenantId]);
    for (let round = 0; round < 20; round++) {
      const run = await owner.query('SELECT lms.rollup_run_tenant($1, now()) AS remaining', [
        tenantId,
      ]);
      if (!Number(run.rows[0].remaining)) break;
    }
    // nothing of this college is left queued for a worker to send later
    await runtime.drain(tenantId, ['courses.sync', 'email.send']);
    // mail held back by quiet hours would otherwise go out in the morning, to addresses that do not exist
    await owner.query(
      `UPDATE lms.email_outbox SET status = 'skipped' WHERE tenant_id = $1 AND status = 'queued'`,
      [tenantId],
    );
    await owner.query(
      `DELETE FROM lms.jobs WHERE tenant_id = $1 AND queue = 'email.send' AND status = 'queued'`,
      [tenantId],
    );

    return {
      state,
      stateFile,
      importFile,
      url: runtime.url,
      tenantId,
      emails: {
        admin: people.admin.email,
        instructors: people.instructors.map((p) => p.email),
        assistant: people.assistant.email,
        learner: people.learners[0]?.email as string,
      },
    };
  } finally {
    await runtime?.close().catch(() => {});
    await owner.end().catch(() => {});
  }
}

/** What the command prints at the end. */
export function signInSheet(r: SeedResult): string {
  const s = r.state;
  return [
    '',
    `Demo college ready: ${r.url}`,
    `Password of every account: ${s.password}`,
    '',
    `Institution admin  ${r.emails.admin}   (two-step sign-in, below)`,
    `Instructor         ${r.emails.instructors[0]}   Data Structures`,
    `Instructor         ${r.emails.instructors[1]}   Engineering Mechanics`,
    `Assistant          ${r.emails.assistant}   Data Structures`,
    `Learner            ${r.emails.learner}`,
    '',
    "The admin's authenticator secret (add it to an authenticator app, type TOTP, 6 digits, 30 s):",
    `  ${s.adminTotpSecret}`,
    'One-time recovery codes (each works once, if the phone is not at hand):',
    `  ${s.adminRecoveryCodes.join('  ')}`,
    '',
    `Saved to ${r.stateFile} (git-ignored; it holds these secrets of this throwaway college).`,
    `Students to import during the demo: ${r.importFile}`,
    '',
  ].join('\n');
}
