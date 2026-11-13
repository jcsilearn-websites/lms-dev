import type { Explanation, LearnerGrades } from '@lms/backend/contracts';
import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ExplanationView, itemLine } from '../src/features/gradebook/ExplanationView';
import { renderApp } from './render';
import { API, memberMe, mockSignedIn, server } from './server';

// The explanation panel and the learner's grades page (step 11). Typed with the contracts.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const explanation: Explanation = {
  weighted: true,
  outOf: 50,
  rounding: { mode: 'half_even', decimals: 1 },
  weightTotal: 100,
  unrounded: 27.04,
  rounded: 27,
  final: 27,
  percent: 54,
  grade: 'C',
  isPass: true,
  overridden: false,
  categories: [
    {
      id: uuid(1),
      name: 'Tests',
      weight: 60,
      dropLowest: 1,
      missingPolicy: 'exclude',
      counts: true,
      earned: 9,
      max: 10,
      percent: 90,
      items: [
        {
          id: uuid(11),
          title: 'T1',
          state: 's',
          points: 10,
          extra: false,
          dropped: true,
          earned: 3,
          percent: 30,
        },
        {
          id: uuid(12),
          title: 'T2',
          state: 's',
          points: 10,
          extra: false,
          dropped: false,
          earned: 9,
          percent: 90,
        },
      ],
    },
    {
      id: uuid(2),
      name: 'Labs',
      weight: 40,
      dropLowest: 0,
      missingPolicy: 'zero_after_due',
      counts: true,
      earned: 0,
      max: 10,
      percent: 0,
      items: [
        {
          id: uuid(21),
          title: 'L1',
          state: 'z',
          points: 10,
          extra: false,
          dropped: false,
          earned: 0,
          percent: 0,
        },
        {
          id: uuid(22),
          title: 'L2',
          state: 'x',
          points: 10,
          extra: false,
          dropped: false,
          earned: null,
          percent: null,
        },
        {
          id: uuid(23),
          title: 'Bonus',
          state: 'o',
          points: 5,
          extra: true,
          dropped: false,
          earned: 2,
          percent: 40,
        },
        {
          id: uuid(24),
          title: 'Essay',
          state: 'p',
          points: 20,
          extra: false,
          dropped: false,
          earned: null,
          percent: null,
        },
      ],
    },
    {
      id: uuid(3),
      name: 'Seminar',
      weight: 0,
      dropLowest: 0,
      missingPolicy: 'exclude',
      counts: false,
      earned: null,
      max: null,
      percent: null,
      items: [],
    },
  ],
};

describe('ExplanationView', () => {
  it('shows every category with what counted, what was dropped and what was left out, in words', () => {
    render(<ExplanationView explanation={explanation} provisional={false} />);
    const tests = screen.getByRole('region', { name: 'Tests' });
    expect(within(tests).getByText(/weight 60/)).toBeInTheDocument();
    expect(within(tests).getByText('9 / 10 = 90 %')).toBeInTheDocument();
    expect(
      within(tests).getByText(/lowest item is dropped \(never the last one\)/),
    ).toBeInTheDocument();
    expect(within(tests).getByText('T1')).toHaveClass('line-through');
    expect(within(tests).getByText('Dropped (one of the lowest): 3 / 10')).toBeInTheDocument();
    const labs = screen.getByRole('region', { name: 'Labs' });
    expect(
      within(labs).getByText(/Work that is missing after its due date counts as 0/),
    ).toBeInTheDocument();
    expect(within(labs).getByText('0 / 10')).toBeInTheDocument();
    expect(within(labs).getByText('Not counted yet: no mark')).toBeInTheDocument();
    expect(within(labs).getByText('Handed in, waiting to be graded')).toBeInTheDocument();
    expect(within(labs).getByText('2 / 5 (extra credit)')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Seminar' })).getByText('Nothing counts here yet'),
    ).toBeInTheDocument();
  });

  it('shows the weights, the unrounded number, the rounding rule and the final with its grade', () => {
    render(<ExplanationView explanation={explanation} provisional={false} />);
    const fin = screen.getByRole('region', { name: 'The final' });
    expect(within(fin).getByText('Final total')).toBeInTheDocument();
    expect(
      within(fin).getByText(/Weights of the categories that count add up to 100/),
    ).toBeInTheDocument();
    expect(
      within(fin).getByText(
        /Before rounding: 27.04 out of 50\. Rounded half to even to 1 decimal\./,
      ),
    ).toBeInTheDocument();
    expect(within(fin).getByText(/27 out of 50/)).toBeInTheDocument();
    expect(within(fin).getByText(/Grade C/)).toBeInTheDocument();
    expect(within(fin).queryByText('Provisional')).toBeNull();
  });

  it('says PROVISIONAL in words, not only by colour', () => {
    render(<ExplanationView explanation={{ ...explanation, grade: null }} provisional />);
    const fin = screen.getByRole('region', { name: 'The final' });
    expect(within(fin).getByText('Provisional total')).toBeInTheDocument();
    expect(within(fin).getByText('Provisional')).toBeInTheDocument();
    expect(within(fin).queryByText(/Grade/)).toBeNull();
  });

  it('a final set by the instructor says so instead of an unrounded number; nothing to calculate is said plainly', () => {
    const { rerender } = render(
      <ExplanationView explanation={{ ...explanation, overridden: true }} provisional={false} />,
    );
    expect(screen.getByText('The final was set by the instructor.')).toBeInTheDocument();
    expect(screen.queryByText(/Before rounding/)).toBeNull();
    rerender(
      <ExplanationView
        explanation={{
          ...explanation,
          final: null,
          percent: null,
          unrounded: null,
          rounded: null,
          grade: null,
        }}
        provisional
      />,
    );
    expect(screen.getByText('There is nothing to calculate yet.')).toBeInTheDocument();
  });

  it('an unweighted gradebook explains the pool of points', () => {
    render(
      <ExplanationView explanation={{ ...explanation, weighted: false }} provisional={false} />,
    );
    expect(
      screen.getByText(/points of all items that count are added together/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/weight 60/)).toBeNull();
  });

  it('itemLine words', () => {
    expect(
      itemLine({
        id: uuid(1),
        title: 't',
        state: 'h',
        points: 1,
        extra: false,
        dropped: false,
        earned: null,
        percent: null,
      }),
    ).toBe('Not released');
  });
});

describe('the learner grades page', () => {
  const OFFERING = uuid(777);
  const grades = (over: Partial<LearnerGrades>): LearnerGrades => ({
    status: 'draft',
    provisional: true,
    underRevision: false,
    versionNo: 1,
    final: { marks: 27, percent: 54, grade: null, isPass: null },
    explanation: { ...explanation, grade: null, isPass: null },
    ...over,
  });

  it('labels the running total PROVISIONAL until the gradebook is approved', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/offerings/${OFFERING}/me/grades`, () => HttpResponse.json(grades({}))),
    );
    renderApp(`/offerings/${OFFERING}/grades`);
    expect(
      await screen.findByText(/use only the results released to you so far/),
    ).toBeInTheDocument();
    expect(screen.getByText('Running total')).toBeInTheDocument();
    expect(screen.getByTestId('final-marks')).toHaveTextContent('27 / 50');
    expect(screen.queryByTestId('final-grade')).toBeNull();
    expect(screen.getAllByText('Provisional').length).toBeGreaterThan(0);
  });

  it('says the final is being revised after an unlock, and shows the approved record with its grade', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/offerings/${OFFERING}/me/grades`, () =>
        HttpResponse.json(grades({ underRevision: true, versionNo: 2 })),
      ),
    );
    const first = renderApp(`/offerings/${OFFERING}/grades`);
    expect(
      await screen.findByText(/final grade of this course is being revised/),
    ).toBeInTheDocument();
    first.unmount();
    server.use(
      http.get(`${API}/offerings/${OFFERING}/me/grades`, () =>
        HttpResponse.json(
          grades({
            status: 'locked',
            provisional: false,
            versionNo: 3,
            final: { marks: 27, percent: 54, grade: 'C', isPass: true },
            explanation,
          }),
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING}/grades`);
    expect(await screen.findByText(/approved record \(version 3\)/)).toBeInTheDocument();
    expect(screen.getByTestId('final-grade')).toHaveTextContent('Grade C');
    expect(screen.getAllByText('Final total').length).toBeGreaterThan(0);
  });

  it('a failed load says so and offers a retry', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/offerings/${OFFERING}/me/grades`, () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );
    renderApp(`/offerings/${OFFERING}/grades`);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
