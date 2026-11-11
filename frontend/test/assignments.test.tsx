import type {
  AssignmentMe,
  GradingLearner,
  GradingQueue,
  GradingRow,
  SubmitAssignmentRequest,
} from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFERING_ID } from './courses-fixtures';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// the rich-text editor (Tiptap) has its own test; here it is a plain box so the screens load fast
vi.mock('../src/features/courses/editor/RichTextEditor', () => ({
  default: ({ label }: { label: string }) => <textarea aria-label={label} />,
}));

// The assignment screens with the real router against a mocked API: the learner's page (dates by the server's clock, the late
// policy, the hand-in, the CONFIRMATION of a late version that replaces an on-time one, the grade with the penalty shown
// separately) and the grading screen while blind (codes, no names, no name ordering).

const ITEM = '0a000000-0000-7000-8000-0000000000b1';
const base = `${API}/offerings/${OFFERING_ID}`;
const A = `${base}/items/${ITEM}/assignment`;
const doc = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
});
const item = {
  id: ITEM,
  moduleId: '0a000000-0000-7000-8000-0000000000c1',
  kind: 'assignment',
  title: 'Essay',
  published: true,
  availableFrom: null,
  locked: false,
  required: true,
  completion: 'on_submit',
  position: 'a',
  body: null,
  file: null,
  url: null,
  video: null,
};
const progress = {
  participant: true,
  completedRequired: 0,
  totalRequired: 1,
  percent: 0,
  modules: [],
  items: [],
  resume: null,
};
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const me = (
  over: Partial<AssignmentMe> = {},
  a: Partial<AssignmentMe['assignment']> = {},
): AssignmentMe => ({
  serverNow: new Date().toISOString(),
  graceSeconds: 600,
  assignment: {
    itemId: ITEM,
    title: 'Essay',
    instructions: doc('Write five hundred words about copies'),
    opensAt: null,
    dueAt: iso(3 * 3_600_000),
    originalDueAt: iso(3 * 3_600_000),
    hasExtension: false,
    latePolicy: 'allowed',
    lateCutoffAt: iso(5 * 86_400_000),
    penaltyKind: 'per_day',
    penaltyValue: 10,
    penaltyCap: 30,
    maxPoints: 50,
    passingScore: 40,
    allowFile: true,
    allowText: true,
    allowLink: false,
    maxFiles: 3,
    maxFileMb: 25,
    resubmissionAllowed: true,
    anonymousGrading: false,
    releaseMode: 'manual',
    attachments: [],
    ...a,
  },
  state: 'open',
  canSubmit: true,
  draftWithinGrace: false,
  lateSecondsNow: 0,
  penaltyPercentNow: 0,
  penaltyPointsNow: 0,
  counts: null,
  submissions: [],
  drafts: [],
  grade: null,
  ...over,
});

beforeEach(() => {
  mockSignedIn(memberMe);
  server.use(
    http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(item)),
    http.get(`${base}/progress`, () => HttpResponse.json(progress)),
  );
});

describe('the assignment page of a learner', () => {
  it('shows the task, THEIR due date, the late policy in points and the grace rule; the countdown uses the server clock', async () => {
    // the server is two hours AHEAD of this browser: the page must not count from the browser's time
    const serverNow = iso(2 * 3_600_000);
    server.use(
      http.get(`${A}/me`, () =>
        HttpResponse.json(
          me(
            { serverNow },
            { dueAt: new Date(new Date(serverNow).getTime() + 90 * 60_000).toISOString() },
          ),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText('Write five hundred words about copies')).toBeInTheDocument();
    expect(screen.getByTestId('countdown')).toHaveTextContent(
      /1 hour 2[89] minutes|1 hour 30 minutes|1 hour 29 minutes/,
    );
    expect(screen.getByTestId('late-policy')).toHaveTextContent(
      /10% of the maximum \(5 points\) for every day/,
    );
    expect(screen.getByTestId('late-policy')).toHaveTextContent(
      /never more than 30% \(15 points\)/,
    );
    expect(screen.getByTestId('grace-note')).toHaveTextContent(
      /START uploading a file before the due date and hand in within 10 minutes/,
    );
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('hands in text with a request key; a repeat of the same hand-in carries the SAME key', async () => {
    const bodies: SubmitAssignmentRequest[] = [];
    server.use(
      http.get(`${A}/me`, () => HttpResponse.json(me())),
      http.post(`${A}/submissions`, async ({ request }) => {
        bodies.push((await request.json()) as SubmitAssignmentRequest);
        return HttpResponse.json({
          result: 'ok',
          submissionId: ITEM,
          versionNo: 1,
          lateSeconds: 0,
          onGrace: false,
          penaltyPercent: 0,
        });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    const text = await screen.findByLabelText('Your text');
    expect(screen.getByRole('button', { name: 'Hand in' })).toBeDisabled();
    await user.type(text, 'my answer');
    await user.click(screen.getByRole('button', { name: 'Hand in' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ text: 'my answer', fileIds: [] });
    expect(bodies[0]?.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Handed in as version 1/)).toBeInTheDocument();
  });

  it('LATE REPLACING ON TIME: shows the exact penalty and writes nothing until the learner confirms with the same key', async () => {
    const bodies: SubmitAssignmentRequest[] = [];
    server.use(
      http.get(`${A}/me`, () =>
        HttpResponse.json(
          me({
            state: 'late',
            lateSecondsNow: 30 * 3600,
            penaltyPercentNow: 20,
            penaltyPointsNow: 10,
            counts: 1,
            submissions: [
              {
                id: ITEM,
                versionNo: 1,
                submittedAt: iso(-86_400_000),
                lateSeconds: 0,
                onGrace: false,
                text: 'first',
                link: null,
                penaltyPercent: 0,
                files: [],
              },
            ],
          }),
        ),
      ),
      http.post(`${A}/submissions`, async ({ request }) => {
        const body = (await request.json()) as SubmitAssignmentRequest;
        bodies.push(body);
        if (!body.confirmLate)
          return HttpResponse.json({
            result: 'confirm_late',
            lateSeconds: 108000,
            penaltyPercent: 20,
            penaltyPoints: 10,
            maxPoints: 50,
            currentVersionNo: 1,
          });
        return HttpResponse.json({
          result: 'ok',
          submissionId: ITEM,
          versionNo: 2,
          lateSeconds: 108000,
          onGrace: false,
          penaltyPercent: 20,
        });
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    // before anything is sent the page already says what it costs
    expect(await screen.findByTestId('late-now')).toHaveTextContent(/20% = 10 points of 50 points/);
    await user.type(await screen.findByLabelText('Your text'), 'better answer');
    await user.click(screen.getByRole('button', { name: /Hand in late \(20% penalty\)/ }));
    // the confirmation: the exact figures from the server, and a way to keep the on-time version
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('late-confirm-penalty')).toHaveTextContent(
      /20% = 10 points of 50 points/,
    );
    expect(within(dialog).getByText(/version 1 was handed in on time/)).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.confirmLate).toBeUndefined();
    // keeping the on-time version sends nothing more
    await user.click(within(dialog).getByRole('button', { name: 'Keep my on-time version' }));
    expect(bodies).toHaveLength(1);
    // confirming sends the same request again with confirmLate and the SAME key
    await user.click(screen.getByRole('button', { name: /Hand in late \(20% penalty\)/ }));
    const again = await screen.findByRole('dialog');
    await user.click(within(again).getByRole('button', { name: /Hand in late \(20% penalty\)/ }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]?.confirmLate).toBe(true);
    expect(bodies[2]?.requestKey).toBe(bodies[0]?.requestKey);
    expect(
      await screen.findByText(/Handed in as version 2: .* late, 20% penalty/),
    ).toBeInTheDocument();
  });

  it('a closed assignment says so and offers no form', async () => {
    server.use(
      http.get(`${A}/me`, () => HttpResponse.json(me({ state: 'closed', canSubmit: false }))),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByTestId('cannot-submit')).toHaveTextContent(
      /nothing more is accepted/,
    );
    expect(screen.queryByRole('button', { name: /Hand in/ })).not.toBeInTheDocument();
  });

  it('every version is listed (the latest is marked), with its lateness', async () => {
    server.use(
      http.get(`${A}/me`, () =>
        HttpResponse.json(
          me({
            counts: 2,
            submissions: [
              {
                id: '0a000000-0000-7000-8000-0000000000d2',
                versionNo: 2,
                submittedAt: iso(-3600_000),
                lateSeconds: 7200,
                onGrace: false,
                text: null,
                link: null,
                penaltyPercent: 10,
                files: [
                  {
                    fileId: '0a000000-0000-7000-8000-0000000000f2',
                    name: 'v2.pdf',
                    size: 2048,
                    contentType: 'application/pdf',
                  },
                ],
              },
              {
                id: '0a000000-0000-7000-8000-0000000000d1',
                versionNo: 1,
                submittedAt: iso(-86_400_000),
                lateSeconds: 0,
                onGrace: true,
                text: 'hello',
                link: null,
                penaltyPercent: 0,
                files: [],
              },
            ],
          }),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText('This one counts')).toBeInTheDocument();
    expect(screen.getByText(/Late by 2 hours: 10% penalty/)).toBeInTheDocument();
    expect(screen.getByText(/On time \(upload began before the due date\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /v2\.pdf/ })).toBeInTheDocument();
  });

  it('the grade shows the raw score, the late penalty and the final score SEPARATELY, and the rubric', async () => {
    server.use(
      http.get(`${A}/me`, () =>
        HttpResponse.json(
          me({
            counts: 1,
            grade: {
              submissionVersionNo: 1,
              rawScore: 40,
              penaltyPercent: 20,
              penaltyPoints: 10,
              penaltyWaived: false,
              finalScore: 30,
              maxPoints: 50,
              passingScore: 40,
              feedback: doc('Good structure'),
              gradedAt: iso(-1000),
              releasedAt: iso(-500),
              overridden: false,
              rubric: {
                criteria: [
                  {
                    id: 'c1c1c1c1c1c1',
                    title: 'Content',
                    description: '',
                    levels: [
                      { id: 'l1l1l1l1l1l1', title: 'Excellent', description: '', points: 10 },
                    ],
                  },
                ],
                selection: {
                  c1c1c1c1c1c1: { levelId: 'l1l1l1l1l1l1', points: 10, comment: 'strong' },
                },
              },
              files: [],
            },
          }),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByTestId('grade-raw')).toHaveTextContent('40 / 50');
    expect(screen.getByTestId('grade-penalty')).toHaveTextContent(/− 10 points \(20%\)/);
    expect(screen.getByTestId('grade-final')).toHaveTextContent('30 / 50');
    expect(screen.getByTestId('grade-final')).toHaveTextContent('Passed');
    expect(screen.getByText('Good structure')).toBeInTheDocument();
    expect(screen.getByText('strong')).toBeInTheDocument();
  });

  it('a waived penalty is said so', async () => {
    server.use(
      http.get(`${A}/me`, () =>
        HttpResponse.json(
          me({
            grade: {
              submissionVersionNo: 1,
              rawScore: 40,
              penaltyPercent: 0,
              penaltyPoints: 0,
              penaltyWaived: true,
              finalScore: 40,
              maxPoints: 50,
              passingScore: null,
              feedback: null,
              gradedAt: iso(-1),
              releasedAt: iso(-1),
              overridden: false,
              rubric: null,
              files: [],
            },
          }),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByTestId('grade-penalty')).toHaveTextContent(
      'Waived by your instructor',
    );
  });

  it('staff (403) get the links to the settings and the grading', async () => {
    server.use(
      http.get(`${A}/me`, () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'no', requestId: 'r' } },
          { status: 403 },
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByRole('link', { name: 'Grading' })).toHaveAttribute(
      'href',
      expect.stringContaining('/assignment/grading'),
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });
});

describe('the grading screen', () => {
  const row = (n: number, over: Partial<GradingRow> = {}): GradingRow => ({
    learnerKey: `0a000000-0000-7000-8000-00000000010${n}`,
    anonCode: String.fromCharCode(64 + n).repeat(6),
    name: null,
    email: null,
    registerNumber: null,
    sectionName: null,
    status: 'submitted',
    versionNo: 1,
    submittedAt: iso(-1000 * n),
    lateSeconds: 0,
    gradeOutdated: false,
    rawScore: null,
    finalScore: null,
    ...over,
  });
  const queue = (blind: boolean, items: GradingRow[]): GradingQueue => ({
    items,
    nextCursor: null,
    blind,
    maxPoints: 50,
  });

  it('blind: rows carry only an anonymous code, the order choices have no name, the page says so', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${A}/grading/queue`, ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(
          queue(true, [
            row(1),
            row(2, { status: 'late', lateSeconds: 3600 }),
            row(3, { status: 'graded', rawScore: 40, finalScore: 36 }),
          ]),
        );
      }),
      http.get(`${A}/grading/summary`, () =>
        HttpResponse.json({
          learners: 3,
          notSubmitted: 0,
          submitted: 1,
          late: 1,
          graded: 1,
          released: 0,
          blind: true,
        }),
      ),
      http.get(`${base}/sections`, () => HttpResponse.json({ items: [] })),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}/assignment/grading`);
    const list = await screen.findByTestId('queue');
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByText('Learner AAAAAA').closest('button')).toBeTruthy();
    expect(screen.getByText(/Blind grading is on/)).toBeInTheDocument();
    // the options of the order: no "Name"
    const order = screen.getByLabelText('Order by') as HTMLSelectElement;
    expect([...order.options].map((o) => o.textContent)).toEqual([
      'Anonymous code',
      'Submission time',
    ]);
    expect(urls[0]).not.toContain('sort=name');
    // the summary of the class
    expect(screen.getByTestId('summary')).toHaveTextContent('Submitted 1');
    expect(screen.getByTestId('summary')).toHaveTextContent('Late 1');
  });

  it('not blind: names, register numbers and the order by name', async () => {
    server.use(
      http.get(`${A}/grading/queue`, () =>
        HttpResponse.json(
          queue(false, [
            row(1, { name: 'Ada Lovelace', registerNumber: 'R100' }),
            row(2, { name: 'Bob Marley', registerNumber: 'R101' }),
          ]),
        ),
      ),
      http.get(`${A}/grading/summary`, () =>
        HttpResponse.json({
          learners: 2,
          notSubmitted: 0,
          submitted: 2,
          late: 0,
          graded: 0,
          released: 0,
          blind: false,
        }),
      ),
      http.get(`${base}/sections`, () => HttpResponse.json({ items: [] })),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}/assignment/grading`);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('R101')).toBeInTheDocument();
    const order = screen.getByLabelText('Order by') as HTMLSelectElement;
    expect([...order.options].map((o) => o.textContent)).toContain('Name');
  });

  it('j and k move through the queue; opening a learner shows the rubric and the score before and after the penalty', async () => {
    const detail = (key: string): GradingLearner => ({
      learnerKey: key,
      anonCode: 'AAAAAA',
      name: 'Ada Lovelace',
      email: 'ada@x.test',
      registerNumber: 'R100',
      blind: false,
      maxPoints: 50,
      passingScore: null,
      rubric: {
        versionId: ITEM,
        title: 'Essay rubric',
        maxPoints: 15,
        criteria: [
          {
            id: 'c1c1c1c1c1c1',
            title: 'Content',
            description: '',
            levels: [
              { id: 'a1a1a1a1a1a1', title: 'Weak', description: '', points: 0 },
              { id: 'a2a2a2a2a2a2', title: 'Strong', description: '', points: 10 },
            ],
          },
          {
            id: 'c2c2c2c2c2c2',
            title: 'Language',
            description: '',
            levels: [
              { id: 'b1b1b1b1b1b1', title: 'Poor', description: '', points: 0 },
              { id: 'b2b2b2b2b2b2', title: 'Good', description: '', points: 5 },
            ],
          },
        ],
      },
      submissions: [
        {
          id: '0a000000-0000-7000-8000-0000000000d1',
          versionNo: 1,
          submittedAt: iso(-3600_000),
          lateSeconds: 86_400,
          onGrace: false,
          text: 'the essay',
          link: null,
          penaltyPercent: 10,
          files: [],
        },
      ],
      grade: null,
      penaltyPercent: 10,
    });
    const asked: string[] = [];
    server.use(
      http.get(`${A}/grading/queue`, () =>
        HttpResponse.json(
          queue(false, [row(1, { name: 'Ada Lovelace' }), row(2, { name: 'Bob Marley' })]),
        ),
      ),
      http.get(`${A}/grading/summary`, () =>
        HttpResponse.json({
          learners: 2,
          notSubmitted: 0,
          submitted: 2,
          late: 0,
          graded: 0,
          released: 0,
          blind: false,
        }),
      ),
      http.get(`${base}/sections`, () => HttpResponse.json({ items: [] })),
      http.get(`${A}/grading/learners/:key`, ({ params }) => {
        asked.push(String(params.key));
        return HttpResponse.json(detail(String(params.key)));
      }),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}/assignment/grading`);
    await screen.findByText('Ada Lovelace');
    await user.keyboard('j');
    expect(await screen.findByTestId('learner-heading')).toBeInTheDocument();
    expect(asked).toHaveLength(1);
    await user.keyboard('j');
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).not.toBe(asked[0]);
    const buttons = within(screen.getByTestId('queue')).getAllByRole('button');
    expect(buttons[1]).toHaveAttribute('aria-current', 'true');
    // back to the first (its learner is cached: no second request)
    await user.keyboard('k');
    await waitFor(() => expect(buttons[0]).toHaveAttribute('aria-current', 'true'));
    expect(asked).toHaveLength(2);
    // pick the levels: the rubric score is the sum, the late penalty is shown on its own, then the final score
    await user.click(await screen.findByLabelText(/Strong/));
    await user.click(screen.getByLabelText(/Good/));
    expect(screen.getByTestId('rubric-score')).toHaveTextContent('15');
    expect(screen.getByTestId('penalty')).toHaveTextContent(/− 5 points \(10%\)/);
    expect(screen.getByTestId('score-breakdown')).toHaveTextContent(/10 \/ 50/);
    // typing in a field does not move the queue
    await user.type(screen.getByLabelText('Comment on Content'), 'jjj');
    expect(buttons[0]).toHaveAttribute('aria-current', 'true');
    expect(asked).toHaveLength(2);
  });
});
