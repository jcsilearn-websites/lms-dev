import type { GradebookConfig, GridRow } from '@lms/backend/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GradebookGrid, type GradebookGridProps } from '../src/features/gradebook/GradebookGrid';

// The grid component (step 11): the spreadsheet keyboard, typing a mark, Delete, paste from Excel, the locked state, the ARIA
// grid roles. jsdom has no layout, so the grid is given the size of its viewport.

// jsdom has no layout: the virtualizer reads the size of its scroll element from clientWidth / clientHeight
const sizes = {
  w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1400,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
});
afterAll(() => {
  if (sizes.w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sizes.w);
  if (sizes.h) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizes.h);
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAT = id(900);
const config: GradebookConfig = {
  id: id(1),
  offeringId: id(2),
  status: 'draft',
  versionNo: 1,
  weighted: true,
  outOf: 40,
  roundMode: 'half_up',
  roundDecimals: 0,
  scale: null,
  categories: [{ id: CAT, name: 'Tests', weight: 100, dropLowest: 0, missingPolicy: 'exclude' }],
  items: [
    {
      id: id(10),
      categoryId: CAT,
      source: 'manual',
      contentItemId: null,
      title: 'Test 1',
      points: 50,
      extraCredit: false,
      dueAt: null,
      released: true,
      assistantsMayEnter: false,
    },
    {
      id: id(11),
      categoryId: CAT,
      source: 'manual',
      contentItemId: null,
      title: 'Test 2',
      points: 50,
      extraCredit: false,
      dueAt: null,
      released: true,
      assistantsMayEnter: false,
    },
    {
      id: id(12),
      categoryId: CAT,
      source: 'assessment',
      contentItemId: id(50),
      title: 'Quiz',
      points: 10,
      extraCredit: false,
      dueAt: null,
      released: false,
      assistantsMayEnter: false,
    },
  ],
  exportLayout: null,
  submittedAt: null,
  submittedBy: null,
  reviewComment: null,
  selfApprovalAllowed: false,
  lockedVersions: [],
  events: [],
  candidates: [],
  markCounts: {},
};
const row = (n: number, name: string, t1: [string, string | null, number]): GridRow => ({
  participantId: id(100 + n),
  name,
  email: `${name.toLowerCase()}@x.test`,
  registerNumber: `R${n}`,
  section: 'A',
  cells: { [id(10)]: t1, [id(11)]: ['x', null, 0], [id(12)]: ['s', '8', 0] } as GridRow['cells'],
  cats: { [CAT]: { e: 8, m: 10, p: 80 } },
  finalMarks: 32,
  finalPercent: 80,
  grade: 'A',
  isPass: true,
  overridden: false,
});
const rows = [
  row(1, 'Asha', ['s', '40', 0]),
  row(2, 'Bala', ['x', null, 0]),
  row(3, 'Chitra', ['o', '45', 0]),
];

function setup(over: Partial<GradebookGridProps> = {}) {
  const onCommit = vi.fn(async () => {});
  const onExplain = vi.fn();
  const onNotice = vi.fn();
  render(
    <GradebookGrid
      rows={rows}
      config={config}
      canEnter={() => true}
      locked={false}
      onCommit={onCommit}
      onExplain={onExplain}
      onNotice={onNotice}
      viewport={{ width: 1400, height: 600 }}
      {...over}
    />,
  );
  const grid = screen.getByRole('grid', { name: 'Gradebook' });
  return { grid, onCommit, onExplain, onNotice };
}
const selected = () =>
  screen.getAllByRole('gridcell').filter((c) => c.getAttribute('aria-selected') === 'true');
const label = () => selected()[0]?.getAttribute('aria-label') ?? '';

describe('GradebookGrid', () => {
  it('is an ARIA grid: one tab stop, column headers, row headers (the learner), labelled cells', () => {
    const { grid } = setup();
    expect(grid).toHaveAttribute('tabindex', '0');
    expect(grid).toHaveAttribute('aria-rowcount', '4');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Learner');
    expect(screen.getByRole('columnheader', { name: /Test 1/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Asha/ })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Asha, Test 1: 40' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Bala, Test 1: no mark' })).toBeInTheDocument();
    expect(
      screen.getByRole('gridcell', { name: /Chitra, Test 1: 45, adjusted/ }),
    ).toBeInTheDocument();
    // manual columns are editable, the quiz and the totals are read only
    expect(screen.getByRole('gridcell', { name: 'Asha, Test 1: 40' })).not.toHaveAttribute(
      'aria-readonly',
    );
    expect(screen.getByRole('gridcell', { name: /Asha, Quiz: 8/ })).toHaveAttribute(
      'aria-readonly',
      'true',
    );
  });

  it('arrow keys, Home / End and Ctrl+Home / End move the selection like a spreadsheet', async () => {
    const user = userEvent.setup();
    const { grid } = setup();
    grid.focus();
    expect(label()).toMatch(/Asha, Test 1/);
    await user.keyboard('{ArrowDown}');
    expect(label()).toMatch(/Bala, Test 1/);
    await user.keyboard('{ArrowRight}');
    expect(label()).toMatch(/Bala, Test 2/);
    await user.keyboard('{End}');
    expect(label()).toMatch(/Bala, Grade/);
    await user.keyboard('{Home}');
    expect(label()).toMatch(/Bala, Test 1/);
    await user.keyboard('{Control>}{End}{/Control}');
    expect(label()).toMatch(/Chitra, Grade/);
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(label()).toMatch(/Asha, Test 1/);
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(label()).toMatch(/Asha, Test 1/); // the edges hold
  });

  it('typing a digit opens the cell; Enter saves it (with the value that was shown) and moves down', async () => {
    const user = userEvent.setup();
    const { grid, onCommit } = setup();
    grid.focus();
    await user.keyboard('4');
    const input = await screen.findByRole('textbox', { name: 'Mark for Asha in Test 1' });
    expect(input).toHaveValue('4');
    await user.keyboard('2.5{Enter}');
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith([
      { itemId: id(10), participantId: id(101), points: '42.5', expected: '40' },
    ]);
    expect(label()).toMatch(/Bala, Test 1/);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(grid).toHaveFocus();
  });

  it('Enter edits the shown value, Escape cancels, an unchanged value is not sent, a bad one is explained', async () => {
    const user = userEvent.setup();
    const { grid, onCommit, onNotice } = setup();
    grid.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('textbox')).toHaveValue('40');
    await user.keyboard('{Escape}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(grid).toHaveFocus();
    await user.keyboard('{Enter}{Enter}'); // open, then save the same value
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await user.clear(await screen.findByRole('textbox'));
    await user.keyboard('abc{Enter}');
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/"abc" is not a mark/));
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await user.clear(await screen.findByRole('textbox'));
    await user.keyboard('51{Enter}');
    expect(onNotice).toHaveBeenLastCalledWith(expect.stringMatching(/out of 50/));
  });

  it('Delete clears the mark of an editable cell, and only there', async () => {
    const user = userEvent.setup();
    const { grid, onCommit } = setup();
    grid.focus();
    await user.keyboard('{Delete}');
    expect(onCommit).toHaveBeenCalledWith([
      { itemId: id(10), participantId: id(101), points: null, expected: '40' },
    ]);
    onCommit.mockClear();
    await user.keyboard('{ArrowRight}{ArrowRight}{Delete}'); // the quiz column: read only
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Tab moves along the row, and leaves the grid at the ends (no keyboard trap)', async () => {
    const user = userEvent.setup();
    const { grid } = setup();
    grid.focus();
    await user.tab();
    expect(label()).toMatch(/Asha, Test 2/);
    await user.tab({ shift: true });
    expect(label()).toMatch(/Asha, Test 1/);
    fireEvent.keyDown(grid, { key: 'Tab', shiftKey: true });
    expect(label()).toMatch(/Asha, Test 1/); // the first cell: Shift+Tab is left to the browser
  });

  it('pasting from Excel fills a block from the selected cell and sends it as ONE batch', async () => {
    const { grid, onCommit, onNotice } = setup();
    grid.focus();
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: 'Bala, Test 1: no mark' }));
    fireEvent.paste(grid, { clipboardData: { getData: () => '31\t32\r\n\t' } });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith([
      { itemId: id(10), participantId: id(102), points: '31', expected: null },
      { itemId: id(11), participantId: id(102), points: '32', expected: null },
      { itemId: id(10), participantId: id(103), points: null }, // Chitra's mark is overridden: no stale check
      { itemId: id(11), participantId: id(103), points: null, expected: null },
    ]);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('a paste that does not fit is reported cell by cell, and the cells that fit are still sent', async () => {
    const { grid, onCommit, onNotice } = setup();
    grid.focus();
    fireEvent.paste(grid, { clipboardData: { getData: () => '10\t=1+1\t5' } });
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(onCommit).toHaveBeenCalledWith([
      { itemId: id(10), participantId: id(101), points: '10', expected: '40' },
    ]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/2 pasted cells not applied/));
  });

  it('a locked gradebook accepts neither typing nor paste nor Delete', async () => {
    const user = userEvent.setup();
    const { grid, onCommit, onNotice } = setup({ locked: true });
    grid.focus();
    await user.keyboard('5');
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.keyboard('{Delete}');
    fireEvent.paste(grid, { clipboardData: { getData: () => '5' } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/locked/));
    expect(screen.getByRole('gridcell', { name: 'Asha, Test 1: 40' })).toHaveAttribute(
      'aria-readonly',
      'true',
    );
  });

  it('an assistant types only where the item allows it', () => {
    setup({ canEnter: (i) => i.assistantsMayEnter });
    expect(screen.getByRole('gridcell', { name: 'Asha, Test 1: 40' })).toHaveAttribute(
      'aria-readonly',
      'true',
    );
  });

  it('the learner name opens the explanation; Enter on a read-only cell does too', async () => {
    const user = userEvent.setup();
    const { grid, onExplain } = setup();
    await user.click(
      within(screen.getByRole('rowheader', { name: /Bala/ })).getByRole('button', { name: /Bala/ }),
    );
    expect(onExplain).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bala' }));
    grid.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(onExplain).toHaveBeenCalledTimes(2);
  });

  it('shows what each state means in words, not only by look: adjusted, counted as zero, dropped', () => {
    const r = row(4, 'Dev', ['z', '0', 0]);
    r.cells[id(11)] = ['s', '9', 1];
    setup({ rows: [r] });
    expect(
      screen.getByRole('gridcell', { name: /Dev, Test 1: 0, counted as zero/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: /Dev, Test 2: 9, dropped/ })).toBeInTheDocument();
  });
});
