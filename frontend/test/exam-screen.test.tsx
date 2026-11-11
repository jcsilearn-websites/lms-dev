import type {
  AssessmentMe,
  AttemptDto,
  ResultDto,
  SaveRequest,
  SaveResponse,
} from '@lms/backend/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { queueKey } from '../src/features/assessments/exam/answerQueue';
import { OFFERING_ID } from './courses-fixtures';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// The learner's exam screen with the real router, queue and clock against a mocked API: the paper, answering,
// autosave, the offline notice, a restore after a reload, the submit dialog that lists unanswered questions, the
// result page, and the assessment page that starts an attempt.

const ATTEMPT = '0a000000-0000-7000-8000-0000000000a1';
const ITEM = '0a000000-0000-7000-8000-0000000000b1';
const base = `${API}/offerings/${OFFERING_ID}`;
const doc = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
});

const attempt = (over: Partial<AttemptDto['attempt']> = {}): AttemptDto => ({
  attempt: {
    id: ATTEMPT,
    itemId: ITEM,
    title: 'Midterm',
    kind: 'exam',
    attemptNo: 1,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    serverNow: new Date().toISOString(),
    submittedAt: null,
    ...over,
  },
  questions: [
    {
      position: 1,
      type: 'single_choice',
      points: 2,
      stem: doc('Capital of France?'),
      images: [],
      maxWords: null,
      options: [
        { id: 'aaaaaaaaaaaa', text: doc('Paris') },
        { id: 'bbbbbbbbbbbb', text: doc('Rome') },
      ],
      answer: null,
      rev: 0,
      flagged: false,
    },
    {
      position: 2,
      type: 'numeric',
      points: 1,
      stem: doc('Pi to two places?'),
      images: [],
      maxWords: null,
      options: [],
      answer: null,
      rev: 0,
      flagged: false,
    },
    {
      position: 3,
      type: 'essay',
      points: 5,
      stem: doc('Discuss osmosis.'),
      images: [],
      maxWords: 200,
      options: [],
      answer: { t: 'Saved on the server' },
      rev: 4,
      flagged: true,
    },
  ],
});

const OK: SaveResponse = { result: 'ok', applied: 1, stale: [], serverNow: null, deadlineAt: null };

function mockExam(
  over: { attempt?: AttemptDto; save?: (b: SaveRequest) => Response | Promise<Response> } = {},
) {
  const saves: SaveRequest[] = [];
  const submits: number[] = [];
  server.use(
    http.get(`${base}/attempts/${ATTEMPT}`, () => HttpResponse.json(over.attempt ?? attempt())),
    http.put(`${base}/attempts/${ATTEMPT}/answers`, async ({ request }) => {
      const body = (await request.json()) as SaveRequest;
      saves.push(body);
      return over.save ? over.save(body) : HttpResponse.json(OK);
    }),
    http.post(`${base}/attempts/${ATTEMPT}/submit`, () => {
      submits.push(1);
      return HttpResponse.json({ status: 'graded', submittedAt: new Date().toISOString() });
    }),
  );
  return { saves, submits };
}

beforeEach(() => {
  localStorage.clear();
  mockSignedIn(memberMe);
});

describe('the exam screen', () => {
  it('shows the paper, the timer, the save status and a navigation with answered / flagged in words', async () => {
    mockExam();
    renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    expect(await screen.findByRole('heading', { name: 'Midterm' })).toBeInTheDocument();
    expect(screen.getByText('Capital of France?')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveAccessibleName(/minutes left/);
    expect(screen.getByRole('timer')).toHaveTextContent(/^(29|30):\d\d$/);
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    expect(
      within(nav).getByRole('button', { name: 'Question 1, unanswered, current' }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole('button', { name: 'Question 3, answered, flagged for review' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('saves a chosen answer after a short pause, with the revision the server last had plus one', async () => {
    const { saves } = mockExam();
    const { user } = renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    await user.click(await screen.findByRole('radio', { name: 'Paris' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    await waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(saves[0]?.answers).toEqual([
      expect.objectContaining({
        position: 1,
        answer: { o: ['aaaaaaaaaaaa'] },
        rev: 1,
        flagged: false,
      }),
    ]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('saves at once when the learner moves to another question', async () => {
    const { saves } = mockExam();
    const { user } = renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    await user.click(await screen.findByRole('radio', { name: 'Rome' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(saves.length).toBe(1), { timeout: 1500 }); // well before the 1.8 s pause
    expect(await screen.findByText('Pi to two places?')).toBeInTheDocument();
  });

  it('says "Offline — answers will sync" when the network fails, and sends the answers when it returns', async () => {
    let online = false;
    const { saves } = mockExam({
      save: () => (online ? HttpResponse.json(OK) : HttpResponse.error()),
    });
    const { user } = renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    await user.click(await screen.findByRole('radio', { name: 'Paris' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Offline — answers will sync'),
    );
    expect(screen.getByText(/You are offline\. Keep answering/)).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(queueKey(ATTEMPT)) ?? '{}') as {
      pending: unknown[];
    };
    expect(stored.pending).toHaveLength(1); // kept on the device
    online = true;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    expect(saves.length).toBeGreaterThan(1);
    expect(localStorage.getItem(queueKey(ATTEMPT))).toBeNull();
  });

  it('restores what this device kept after a reload and sends it BEFORE saying "Saved"', async () => {
    localStorage.setItem(
      queueKey(ATTEMPT),
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        pending: [
          { position: 2, answer: { n: 3.14 }, rev: 1, flagged: false, at: Date.now(), spentMs: 0 },
        ],
        events: [],
      }),
    );
    const { saves } = mockExam();
    const { user } = renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    await screen.findByText('Capital of France?');
    await waitFor(() => expect(saves.length).toBe(1));
    expect(saves[0]?.answers[0]).toMatchObject({ position: 2, answer: { n: 3.14 }, rev: 1 });
    await user.click(screen.getByRole('button', { name: /Question 2, answered/ }));
    expect(await screen.findByLabelText('Your answer (a number)')).toHaveValue('3.14');
  });

  it('the submit dialog lists the unanswered questions, jumps to one, and submits', async () => {
    const { submits } = mockExam();
    server.use(
      http.get(`${base}/attempts/${ATTEMPT}/result`, () =>
        HttpResponse.json({
          result: 'not_released',
          attempt: {
            id: ATTEMPT,
            attemptNo: 1,
            status: 'graded',
            submittedAt: new Date().toISOString(),
          },
          questions: [],
        } satisfies ResultDto),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Submit your answers?' });
    expect(within(dialog).getByText('2 questions are not answered:')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Question 1' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Question 2' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Flagged for review: Question 3/)).toBeInTheDocument();
    // jump to an unanswered question
    await user.click(within(dialog).getByRole('button', { name: 'Question 2' }));
    expect(await screen.findByText('Pi to two places?')).toBeInTheDocument();
    // and submit
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await user.click(await screen.findByRole('button', { name: 'Submit now' }));
    await waitFor(() => expect(submits.length).toBe(1));
    expect(await screen.findByText('Your answers are in.')).toBeInTheDocument();
    expect(localStorage.getItem(queueKey(ATTEMPT))).toBeNull();
  });

  it('opens the result instead of the exam when the attempt is already over', async () => {
    mockExam({ attempt: { ...attempt({ status: 'graded' }), questions: [] } });
    server.use(
      http.get(`${base}/attempts/${ATTEMPT}/result`, () =>
        HttpResponse.json({
          result: 'ok',
          attempt: {
            id: ATTEMPT,
            attemptNo: 1,
            status: 'graded',
            submittedAt: new Date().toISOString(),
            score: 7,
            maxScore: 8,
            percent: 87.5,
            passed: true,
            answersShown: false,
            pendingGrading: false,
            feedback: null,
          },
          questions: [],
        } satisfies ResultDto),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/attempts/${ATTEMPT}/take`);
    expect(await screen.findByTestId('score')).toHaveTextContent('7 / 8');
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(
      screen.getByText('The correct answers are not shown for this assessment.'),
    ).toBeInTheDocument();
  });
});

describe('the assessment page of a learner', () => {
  const me = (over: Partial<AssessmentMe> = {}): AssessmentMe => ({
    serverNow: new Date().toISOString(),
    assessment: {
      itemId: ITEM,
      title: 'Midterm',
      kind: 'exam',
      opensAt: null,
      closesAt: null,
      timeLimitMinutes: 60,
      extraMinutes: 15,
      attemptsAllowed: 2,
      scoring: 'highest',
      passingScore: 40,
      resultsVisibility: 'immediate',
      answersVisibility: 'never',
      questionCount: 20,
    },
    attemptsUsed: 0,
    canStart: true,
    blockedReason: null,
    activeAttemptId: null,
    counted: null,
    attempts: [],
    ...over,
  });
  const item = {
    id: ITEM,
    moduleId: '0a000000-0000-7000-8000-0000000000c1',
    kind: 'assessment',
    title: 'Midterm',
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

  it('shows the rules, includes the extra time, and starts an attempt', async () => {
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(item)),
      http.get(`${base}/items/${ITEM}/assessment/me`, () => HttpResponse.json(me())),
      http.get(`${base}/progress`, () =>
        HttpResponse.json({
          participant: true,
          completedRequired: 0,
          totalRequired: 1,
          percent: 0,
          modules: [],
          items: [],
          resume: null,
        }),
      ),
      http.post(`${base}/items/${ITEM}/attempts`, () =>
        HttpResponse.json({ attemptId: ATTEMPT, resumed: false }),
      ),
    );
    mockExam();
    const { user } = renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByText(/75 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/including 15 extra minutes you were given/)).toBeInTheDocument();
    expect(screen.getByText('0 of 2 used')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Capital of France?')).toBeInTheDocument();
  });

  it('offers to continue a running attempt and shows a released score', async () => {
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(item)),
      http.get(`${base}/items/${ITEM}/assessment/me`, () =>
        HttpResponse.json(
          me({
            canStart: false,
            activeAttemptId: ATTEMPT,
            attemptsUsed: 2,
            counted: { score: 7, maxScore: 8, percent: 87.5 },
            attempts: [
              {
                id: 'x1',
                attemptNo: 1,
                status: 'graded',
                startedAt: new Date().toISOString(),
                submittedAt: new Date().toISOString(),
                resultsVisible: true,
                score: 7,
                maxScore: 8,
                pendingGrading: false,
              },
              {
                id: ATTEMPT,
                attemptNo: 2,
                status: 'in_progress',
                startedAt: new Date().toISOString(),
                submittedAt: null,
                resultsVisible: false,
                score: null,
                maxScore: null,
                pendingGrading: false,
              },
            ],
          }),
        ),
      ),
      http.get(`${base}/progress`, () =>
        HttpResponse.json({
          participant: true,
          completedRequired: 0,
          totalRequired: 1,
          percent: 0,
          modules: [],
          items: [],
          resume: null,
        }),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByRole('link', { name: 'Continue your attempt' })).toBeInTheDocument();
    expect(screen.getByTestId('counted-score')).toHaveTextContent('Your score: 7 / 8 (87.5%)');
    expect(screen.getByRole('link', { name: 'See the result' })).toBeInTheDocument();
  });

  it('an instructor sees the links to the tools instead of a Start button', async () => {
    server.use(
      http.get(`${base}/items/${ITEM}`, () => HttpResponse.json(item)),
      http.get(`${base}/items/${ITEM}/assessment/me`, () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'no', requestId: 'r' } },
          { status: 403 },
        ),
      ),
      http.get(`${base}/progress`, () =>
        HttpResponse.json({
          participant: false,
          completedRequired: 0,
          totalRequired: 0,
          percent: null,
          modules: [],
          items: [],
          resume: null,
        }),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/items/${ITEM}`);
    expect(await screen.findByRole('link', { name: 'Settings and questions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grading and results' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });
});
