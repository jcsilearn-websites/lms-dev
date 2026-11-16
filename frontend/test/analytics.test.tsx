import type {
  ActiveUsers,
  AtRiskPage,
  LearnerDashboard,
  OfferingDashboard,
  ReportTable,
  UsageResponse,
} from '@lms/backend/contracts';
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { Providers } from '../src/app/providers';
import { ChartFrame } from '../src/features/analytics/charts/ChartFrame';
import {
  describeDropOff,
  describeFunnel,
  describeSeries,
  formatNumber,
  heatStep,
  niceMax,
  scale,
  ticks,
} from '../src/features/analytics/charts/chartMath';
import {
  BarChart,
  FunnelChart,
  HeatStrip,
  LineChart,
} from '../src/features/analytics/charts/charts';
import { PlatformUsagePage } from '../src/features/analytics/PlatformUsagePage';
import { OFFERING_ID } from './courses-fixtures';
import { renderApp } from './render';
import { API, adminMe, memberMe, mockSignedIn, server } from './server';

// Step 12 screens: the SVG charts (every one with its summary sentence and a real table), the learner's dashboard, the at-risk list,
// the college dashboard and the platform usage page. Every body is typed with the contracts.

describe('chart math', () => {
  it('rounds an axis maximum to 1, 2 or 5 x 10^n and never to 0', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(2)).toBe(2);
    expect(niceMax(0.3)).toBe(0.5);
    expect(ticks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(scale(50, 100, 200)).toBe(100);
    expect(scale(500, 100, 200)).toBe(200); // clamped
    expect(scale(5, 0, 200)).toBe(0);
  });
  it('formats numbers the Indian way and keeps percent signs', () => {
    expect(formatNumber(1234567)).toBe('12,34,567');
    expect(formatNumber(41.25, '%')).toBe('41.3%');
    expect(formatNumber(3, 'users')).toBe('3 users');
  });
  it('describes a series in words: count, highest, lowest, latest', () => {
    const s = describeSeries(
      [
        { label: '1 Nov', value: 4 },
        { label: '2 Nov', value: 40 },
        { label: '3 Nov', value: 2 },
        { label: '4 Nov', value: 18 },
      ],
      'users',
      'day',
    );
    expect(s).toContain('4 days');
    expect(s).toContain('highest 40 users (2 Nov)');
    expect(s).toContain('lowest 2 users (3 Nov)');
    expect(s).toContain('latest 18 users (4 Nov)');
    expect(describeSeries([])).toBe('No data to show yet.');
  });
  it('describes the funnel and the biggest drop, and a video drop-off', () => {
    expect(
      describeFunnel([
        { label: 'Week 1', value: 100 },
        { label: 'Week 2', value: 80 },
        { label: 'Week 3', value: 30 },
      ]),
    ).toContain('biggest drop is from "Week 2" to "Week 3" (50 learners fewer)');
    expect(
      describeDropOff([
        { fromSecond: 0, percent: 90 },
        { fromSecond: 60, percent: 70 },
        { fromSecond: 125, percent: 20 },
      ]),
    ).toContain('steepest fall is at 2:05');
    expect(heatStep(0, 100)).toBe(0);
    expect(heatStep(100, 100)).toBe(4);
    expect(heatStep(50, 100)).toBe(2);
  });
});

const points = [
  { label: 'Mon', value: 3 },
  { label: 'Tue', value: 9 },
  { label: 'Wed', value: 6 },
];

describe('the charts', () => {
  it('draw one mark per data point and are named for assistive technology', () => {
    const { container } = render(
      <>
        <BarChart data={points} label="Active users per day" />
        <LineChart data={points} label="Trend" />
        <FunnelChart stages={points} label="Funnel" />
        <HeatStrip cells={points} label="Strip" />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Active users per day' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Trend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Funnel' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Strip' })).toBeInTheDocument();
    expect(container.querySelectorAll('svg')).toHaveLength(4);
    expect(container.querySelectorAll('svg')[0]?.querySelectorAll('rect')).toHaveLength(3);
    // the heat strip's cells carry their value as a title (a hover tooltip), and no cell is empty
    expect(container.querySelectorAll('svg')[3]?.querySelectorAll('title')).toHaveLength(3);
  });

  it('handle an empty series without crashing', () => {
    const { container } = render(
      <>
        <BarChart data={[]} label="e1" />
        <LineChart data={[]} label="e2" />
        <FunnelChart stages={[]} label="e3" />
        <HeatStrip cells={[]} label="e4" />
      </>,
    );
    expect(container.querySelectorAll('svg')).toHaveLength(4);
  });

  it('every chart has its summary sentence and the same data as a table, in the page for screen readers and shown on request', async () => {
    const user = userEvent.setup();
    render(
      <ChartFrame
        title="Active users per day"
        summary={describeSeries(points, 'users', 'day')}
        asOf="4 Nov 2026, 10:15"
        columns={[
          { key: 'day', label: 'Day' },
          { key: 'n', label: 'Active users' },
        ]}
        rows={points.map((p) => ({ day: p.label, n: p.value }))}
      >
        <BarChart data={points} label="chart" />
      </ChartFrame>,
    );
    expect(screen.getByText(/3 days: highest 9 users \(Tue\)/)).toBeInTheDocument();
    expect(screen.getByText('Data as of 4 Nov 2026, 10:15')).toBeInTheDocument();
    // the table is in the DOM from the start (visually hidden), with real headers
    const table = screen.getByRole('table', { name: 'Active users per day', hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(4);
    expect(
      within(table).getByRole('columnheader', { name: 'Active users', hidden: true }),
    ).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Tue', hidden: true })).toBeInTheDocument();
    expect(table.parentElement?.className).toContain('sr-only');
    const toggle = screen.getByRole('button', { name: 'Show as table' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show chart' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(table.parentElement?.className).not.toContain('sr-only');
    expect(screen.getByRole('table', { name: 'Active users per day' })).toBeVisible();
  });
});

const learnerDash: LearnerDashboard = {
  timeZone: 'Asia/Kolkata',
  today: '2026-11-14',
  upcoming: [
    {
      kind: 'assignment_due',
      offeringId: OFFERING_ID,
      offeringTitle: 'Algebra',
      itemId: '00000000-0000-7000-8000-0000000000a1',
      title: 'Essay 1',
      at: '2026-11-15T18:29:00Z',
    },
  ],
  released: [
    {
      kind: 'assignment',
      offeringId: OFFERING_ID,
      offeringTitle: 'Algebra',
      itemId: '00000000-0000-7000-8000-0000000000a2',
      title: 'Quiz 2',
      at: '2026-11-13T09:00:00Z',
    },
  ],
  resume: null,
  week: ['10', '11', '12', '13', '14', '15', '16'].map((d) => ({
    date: `2026-11-${d}`,
    active: d === '13' || d === '14',
  })),
  streak: 2,
};

describe('learner dashboard', () => {
  it('shows what is coming up in the COLLEGE time zone, released grades, the week and the streak', async () => {
    mockSignedIn(memberMe);
    server.use(
      http.get(`${API}/me/courses`, () =>
        HttpResponse.json({
          items: [
            {
              id: OFFERING_ID,
              title: 'Algebra',
              courseCode: 'MA1',
              termName: 'T1',
              label: '',
              status: 'published',
              myParticipation: 'learner',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${API}/me/dashboard`, () => HttpResponse.json(learnerDash)),
    );
    renderApp('/');
    const dash = await screen.findByTestId('learner-dashboard');
    expect(within(dash).getByRole('link', { name: 'Essay 1' })).toBeInTheDocument();
    // 18:29 UTC = 23:59 IST on 15 Nov: the college's zone, not the browser's
    expect(dash).toHaveTextContent('15 Nov 2026, 23:59');
    expect(dash).toHaveTextContent('Asia/Kolkata');
    expect(within(dash).getByRole('link', { name: 'Quiz 2' })).toBeInTheDocument();
    expect(dash).toHaveTextContent('Active on 2 of 7 days this week');
    expect(dash).toHaveTextContent('A streak of 2 days in a row');
    expect(dash).toHaveTextContent('Only you can see this');
    expect(within(dash).getByRole('list', { name: 'Days of this week' }).children).toHaveLength(7);
    // a learner is offered no teaching or at-risk screens
    expect(screen.queryByRole('link', { name: /Teaching dashboard/ })).not.toBeInTheDocument();
  });

  it('shows an empty state and an error state with a retry', async () => {
    mockSignedIn(memberMe);
    let fail = true;
    server.use(
      http.get(`${API}/me/courses`, () =>
        HttpResponse.json({
          items: [
            {
              id: OFFERING_ID,
              title: 'Algebra',
              courseCode: 'MA1',
              termName: 'T1',
              label: '',
              status: 'published',
              myParticipation: 'learner',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${API}/me/dashboard`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'x', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({ ...learnerDash, upcoming: [], released: [], streak: 0, week: [] }),
      ),
    );
    const { user } = renderApp('/');
    expect(await screen.findByText('Could not load your dashboard')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing is due soon')).toBeInTheDocument();
  });
});

const staff = {
  ...adminMe,
  permissions: [...adminMe.permissions, 'progress.view_class', 'atrisk.view', 'report.view'],
};

const atRisk: AtRiskPage = {
  asOf: '2026-11-14T07:00:00Z',
  timeZone: 'Asia/Kolkata',
  settings: {
    behindEnabled: true,
    missedDeadlinesEnabled: true,
    missedDeadlines: 2,
    lowScoreEnabled: true,
    passMarkPercent: 40,
    inactiveEnabled: true,
    inactiveDays: 14,
  },
  total: 2,
  nextCursor: null,
  items: [
    {
      participantId: '00000000-0000-7000-8000-0000000000b1',
      displayName: 'Asha Rao',
      email: 'asha@alpha.test',
      rules: [
        {
          rule: 'missed_deadlines',
          summary: 'Missed 2 deadlines (flagged from 2)',
          evidence: [
            'Essay A: due 4 Nov 2026, nothing handed in',
            'Quiz 3: due 8 Nov 2026, nothing handed in',
          ],
        },
      ],
    },
    {
      participantId: '00000000-0000-7000-8000-0000000000b2',
      displayName: 'Bala Iyer',
      email: 'bala@alpha.test',
      rules: [
        {
          rule: 'low_score',
          summary: 'Average of released scores 31.5% is below the pass mark of 40%',
          evidence: ['Essay A: 20.0%'],
        },
      ],
    },
  ],
};

describe('flagged learners', () => {
  it('lists each learner with the rules that fired and the evidence; no score anywhere; export buttons are named', async () => {
    mockSignedIn(staff);
    server.use(
      http.get(`${API}/offerings/${OFFERING_ID}/at-risk`, () => HttpResponse.json(atRisk)),
    );
    renderApp(`/offerings/${OFFERING_ID}/at-risk`);
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('Missed deadlines')).toBeInTheDocument();
    expect(screen.getByText('Essay A: due 4 Nov 2026, nothing handed in')).toBeInTheDocument();
    expect(screen.getByText(/Average of released scores 31.5%/)).toBeInTheDocument();
    expect(screen.getByText('2 learners are flagged.')).toBeInTheDocument();
    expect(screen.getByText(/Data as of 14 Nov 2026, 12:30/)).toBeInTheDocument(); // 07:00 UTC in IST
    expect(
      screen.getByRole('button', { name: 'Export flagged learners as CSV' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Export flagged learners as XLSX' }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/risk score|ranking|probability/i);
    // the rules in force are written out
    expect(screen.getByText('The rules in force at this college')).toBeInTheDocument();
  });

  it('shows the empty state when nobody is flagged, and an error with a retry', async () => {
    mockSignedIn(staff);
    let fail = true;
    server.use(
      http.get(`${API}/offerings/${OFFERING_ID}/at-risk`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'x', requestId: 'r' } },
              { status: 500 },
            )
          : HttpResponse.json({ ...atRisk, items: [], total: 0 }),
      ),
    );
    const { user } = renderApp(`/offerings/${OFFERING_ID}/at-risk`);
    expect(await screen.findByText('Could not load the list')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No learner is flagged')).toBeInTheDocument();
  });
});

const offeringDash: OfferingDashboard = {
  timeZone: 'Asia/Kolkata',
  asOf: '2026-11-14T07:00:00Z',
  learners: 40,
  backlog: { submissions: 7, attempts: 2 },
  upcoming: [
    {
      kind: 'assignment_due',
      offeringId: OFFERING_ID,
      offeringTitle: '',
      itemId: '00000000-0000-7000-8000-0000000000a1',
      title: 'Essay 1',
      at: '2026-11-15T18:29:00Z',
    },
  ],
  funnel: [
    {
      moduleId: '00000000-0000-7000-8000-0000000000c1',
      title: 'Week 1',
      requiredItems: 4,
      started: 38,
      completed: 30,
    },
    {
      moduleId: '00000000-0000-7000-8000-0000000000c2',
      title: 'Week 2',
      requiredItems: 5,
      started: 25,
      completed: 10,
    },
  ],
  assessments: [
    {
      itemId: '00000000-0000-7000-8000-0000000000d1',
      title: 'Quiz 1',
      attempts: 40,
      learners: 40,
      averagePercent: 71.5,
      passRatePercent: 80,
    },
  ],
  atRiskCount: 3,
  recent: [
    { day: '2026-11-12', activeLearners: 12, itemsCompleted: 30, submissions: 2, attempts: 0 },
    { day: '2026-11-13', activeLearners: 20, itemsCompleted: 41, submissions: 9, attempts: 3 },
  ],
};

describe('offering dashboard', () => {
  it('shows the backlog, the funnel with its table alternative, assessments and the activity chart', async () => {
    mockSignedIn(staff);
    server.use(
      http.get(`${API}/offerings/${OFFERING_ID}/dashboard`, () => HttpResponse.json(offeringDash)),
      http.get(`${API}/offerings/${OFFERING_ID}/outline`, () =>
        HttpResponse.json({ offeringId: OFFERING_ID, canEdit: true, modules: [] }),
      ),
    );
    renderApp(`/offerings/${OFFERING_ID}/dashboard`);
    expect(await screen.findByText('Hand-ins waiting for a grade')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(
      screen.getByText(/biggest drop is from "Week 1" to "Week 2" \(20 learners fewer\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Module completion funnel', hidden: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /completed every required item of each module/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('71.5%')).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Active learners per day (last 30 days)', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Data as of 14 Nov 2026, 12:30/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See who and why' })).toHaveAttribute(
      'href',
      `/offerings/${OFFERING_ID}/at-risk`,
    );
    expect(await screen.findByText('This offering has no videos')).toBeInTheDocument();
  });
});

const table = (id: ReportTable['id'], over: Partial<ReportTable>): ReportTable => ({
  id,
  title: String(id),
  summary: 'A summary.',
  asOf: '2026-11-14T07:00:00Z',
  timeZone: 'Asia/Kolkata',
  columns: [{ key: 'name', label: 'Name', kind: 'text' }],
  rows: [],
  truncated: false,
  ...over,
});

describe('college dashboard', () => {
  it('shows active users, the activity chart, results by group, and every table with an export; switching the group refetches', async () => {
    mockSignedIn(staff);
    const au: ActiveUsers = {
      timeZone: 'Asia/Kolkata',
      today: '2026-11-14',
      dau: 12,
      wau: 80,
      mau: 200,
      asOf: '2026-11-14T07:00:00Z',
    };
    const scopes: string[] = [];
    server.use(
      http.get(`${API}/reports/active-users`, () => HttpResponse.json(au)),
      http.get(`${API}/reports/:table`, ({ params, request }) => {
        const id = params.table as ReportTable['id'];
        if (id === 'activity')
          return HttpResponse.json(
            table('activity', {
              title: 'Daily activity',
              columns: [
                { key: 'day', label: 'Day', kind: 'date' },
                { key: 'active_users', label: 'Active users', kind: 'number' },
              ],
              rows: [
                { day: '2026-11-13', active_users: 5 },
                { day: '2026-11-14', active_users: 12 },
              ],
            }),
          );
        if (id === 'organisation') {
          scopes.push(new URL(request.url).searchParams.get('scope') ?? '');
          return HttpResponse.json(
            table('organisation', {
              title: 'Completion',
              columns: [
                { key: 'name', label: 'Group', kind: 'text' },
                { key: 'avg_completion', label: 'Average completion', kind: 'percent' },
              ],
              rows: [
                { name: 'Computing', avg_completion: 61.5 },
                { name: 'Maths', avg_completion: 48 },
              ],
            }),
          );
        }
        return HttpResponse.json(
          table(id, { title: `Table ${id}`, rows: [{ name: `row of ${id}` }] }),
        );
      }),
    );
    const { user } = renderApp('/college-dashboard');
    expect(await screen.findByText('Active users, today')).toBeInTheDocument();
    expect(screen.getAllByText('12').length).toBeGreaterThan(0);
    expect(screen.getAllByText('200').length).toBeGreaterThan(0);
    expect(screen.getByText(/in Asia\/Kolkata; data as of 14 Nov 2026, 12:30/)).toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: 'Active users on each day' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Table at-risk' })).toBeInTheDocument();
    for (const id of ['at-risk', 'grading-backlog', 'gradebooks', 'course-health', 'resources'])
      expect(screen.getByRole('button', { name: `Export Table ${id} as CSV` })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Export Daily activity as XLSX' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(scopes).toEqual(['department']));
    await user.selectOptions(screen.getByLabelText('Group by'), 'section');
    await waitFor(() => expect(scopes).toContain('section'));
    await waitFor(() =>
      expect(screen.getAllByText(/Average completion by section/).length).toBeGreaterThan(0),
    );
  });
});

describe('platform usage', () => {
  it('lists every college for a month with the estimate note, open or closed state, and exports', async () => {
    const usage: UsageResponse = {
      month: '2026-11-01',
      renditionMix: { '360p': 0.2, '720p': 0.8 },
      note: 'Video GB is an estimate: assumed rendition mix.',
      rows: [
        {
          tenantId: '00000000-0000-7000-8000-0000000000e1',
          slug: 'alpha',
          name: 'Alpha College',
          status: 'active',
          provisional: true,
          revision: 0,
          timeZone: 'Asia/Kolkata',
          billableLearners: 120,
          activeUsers: 130,
          videoHours: 40.5,
          videoGbEstimate: 12.345,
          storageGb: 3.2,
          offerings: 20,
          activeOfferings: 18,
          members: 300,
        },
        {
          tenantId: '00000000-0000-7000-8000-0000000000e2',
          slug: 'beta',
          name: 'Beta College',
          status: 'active',
          provisional: false,
          revision: 1,
          timeZone: 'Asia/Kolkata',
          billableLearners: 15,
          activeUsers: 16,
          videoHours: 0,
          videoGbEstimate: 0,
          storageGb: 0.1,
          offerings: 2,
          activeOfferings: 1,
          members: 30,
        },
      ],
    };
    const months: string[] = [];
    server.use(
      http.get(`${API}/platform/usage`, ({ request }) => {
        months.push(new URL(request.url).searchParams.get('month') ?? '');
        return HttpResponse.json(usage);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <Providers client={client}>
        <PlatformUsagePage />
      </Providers>,
    );
    expect(await screen.findByText(/Video GB is an estimate/)).toBeInTheDocument();
    expect(screen.getByText('Open (provisional)')).toBeInTheDocument();
    expect(screen.getByText('Closed, revision 1')).toBeInTheDocument();
    expect(screen.getAllByText('120').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('table', { name: 'Billable learners by college', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export usage of .* as CSV/ })).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText('Month'),
      screen.getAllByRole('option')[1] as HTMLElement,
    );
    await waitFor(() => expect(new Set(months).size).toBe(2));
  });
});

describe('college dashboard: Needs attention', () => {
  const dash = (courseHealth: 'on' | 'off') => {
    mockSignedIn(staff);
    server.use(
      http.get(`${API}/reports/active-users`, () =>
        HttpResponse.json({
          timeZone: 'Asia/Kolkata',
          today: '2026-11-14',
          dau: 1,
          wau: 1,
          mau: 1,
          asOf: null,
        }),
      ),
      http.get(`${API}/reports/:table`, ({ params }) => {
        const id = params.table as ReportTable['id'];
        if (id === 'course-health' && courseHealth === 'off')
          return HttpResponse.json(
            {
              error: {
                code: 'report_disabled',
                message: 'This college has switched this report off',
                requestId: 'r',
              },
            },
            { status: 404 },
          );
        if (id === 'course-health')
          return HttpResponse.json(
            table(id, {
              title: 'Needs attention',
              summary:
                '1 running course needs attention. This is about the upkeep of a course, not about any person.',
              columns: [
                { key: 'course', label: 'Course', kind: 'text' },
                { key: 'attention', label: 'Why it needs attention', kind: 'text' },
              ],
              rows: [{ course: 'Algebra', attention: 'No new content in 3 weeks' }],
            }),
          );
        return HttpResponse.json(table(id, { title: `Table ${id}`, rows: [{ name: 'x' }] }));
      }),
    );
  };

  it('shows the reason and says it is about the course, not a person', async () => {
    dash('on');
    renderApp('/college-dashboard');
    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByText('No new content in 3 weeks')).toBeInTheDocument();
    expect(screen.getByText(/not about any person/)).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Why it needs attention' }),
    ).toBeInTheDocument();
  });

  it('is simply absent when the college has switched it off (no error box)', async () => {
    dash('off');
    renderApp('/college-dashboard');
    expect(await screen.findByRole('heading', { name: 'Table at-risk' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load this report')).not.toBeInTheDocument();
  });
});
