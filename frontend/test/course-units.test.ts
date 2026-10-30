import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefetchEditor, resetPrefetch } from '../src/features/courses/editor/loadEditor';
import {
  afterIdFor,
  arrayMove,
  withItem,
  withItemMoved,
  withModule,
  withModuleMoved,
  withoutItem,
  withoutModule,
} from '../src/features/courses/outlineCache';
import { item, moduleOf, outline } from './courses-fixtures';

const m1 = moduleOf(1, [item(1), item(2), item(3)]);
const m2 = moduleOf(2, [item(4)]);
const o = outline([m1, m2], true);
const titles = (list: { title: string }[]) => list.map((x) => x.title);

describe('afterIdFor / arrayMove (where a moved entry goes)', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('names the sibling the entry must follow once it has left its place', () => {
    expect(afterIdFor(ids, 3, 0)).toBeNull(); // d to the front
    expect(afterIdFor(ids, 0, 1)).toBe('b'); // a down one: after b
    expect(afterIdFor(ids, 0, 3)).toBe('d'); // a to the end
    expect(afterIdFor(ids, 3, 1)).toBe('a'); // d to position 2: after a
    expect(afterIdFor(ids, 2, 2)).toBe('b'); // no move: after its own predecessor
  });
  it('arrayMove agrees with it', () => {
    for (let from = 0; from < 4; from++) {
      for (let to = 0; to < 4; to++) {
        const moved = arrayMove(ids, from, to);
        const after = afterIdFor(ids, from, to);
        const at = ids[from] as string;
        expect(after === null ? moved[0] : moved[moved.indexOf(at) - 1]).toBe(
          after === null ? at : after,
        );
      }
    }
  });
});

describe('outline patches', () => {
  it('adds a module at the end, first, or after a sibling', () => {
    const m = { id: 'new', title: 'New', published: false, availableFrom: null };
    expect(withModule(o, m, undefined).modules.map((x) => x.id)).toEqual([m1.id, m2.id, 'new']);
    expect(withModule(o, m, null).modules.map((x) => x.id)).toEqual(['new', m1.id, m2.id]);
    expect(withModule(o, m, m1.id).modules.map((x) => x.id)).toEqual([m1.id, 'new', m2.id]);
  });

  it('moves and deletes modules without touching the original', () => {
    expect(withModuleMoved(o, m2.id, null).modules.map((x) => x.id)).toEqual([m2.id, m1.id]);
    expect(withoutModule(o, m1.id).modules.map((x) => x.id)).toEqual([m2.id]);
    expect(o.modules.map((x) => x.id)).toEqual([m1.id, m2.id]);
  });

  it('moves an item within a module and between modules', () => {
    const [i1, , i3] = m1.items;
    expect(
      titles(withItemMoved(o, (i3 as { id: string }).id, m1.id, null).modules[0]?.items ?? []),
    ).toEqual(['Item 3', 'Item 1', 'Item 2']);
    const across = withItemMoved(o, (i1 as { id: string }).id, m2.id, m2.items[0]?.id ?? null);
    expect(titles(across.modules[0]?.items ?? [])).toEqual(['Item 2', 'Item 3']);
    expect(titles(across.modules[1]?.items ?? [])).toEqual(['Item 4', 'Item 1']);
    expect(across.modules[1]?.items[1]?.moduleId).toBe(m2.id);
  });

  it('adds and removes an item', () => {
    const full = {
      ...item(9, { title: 'Nine', moduleId: m2.id }),
      body: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(titles(withItem(o, full, undefined).modules[1]?.items ?? [])).toEqual([
      'Item 4',
      'Nine',
    ]);
    expect(titles(withoutItem(o, m1.items[1]?.id ?? '').modules[0]?.items ?? [])).toEqual([
      'Item 1',
      'Item 3',
    ]);
  });
});

describe('the editor chunk is fetched ahead of time, once, in idle time', () => {
  beforeEach(() => resetPrefetch());
  afterEach(() => vi.restoreAllMocks());

  it('schedules ONE idle callback however often it is called', () => {
    const ric = vi.fn();
    vi.stubGlobal('requestIdleCallback', ric);
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = ric;
    prefetchEditor();
    prefetchEditor();
    prefetchEditor();
    expect(ric).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the user asked to save data', () => {
    const ric = vi.fn();
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = ric;
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });
    prefetchEditor();
    expect(ric).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
  });
});
