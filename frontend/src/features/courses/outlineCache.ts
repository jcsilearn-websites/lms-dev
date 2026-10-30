import type {
  ItemDto,
  ModuleDto,
  OutlineDto,
  OutlineItem,
  OutlineModule,
} from '@lms/backend/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { courseKeys } from './courses.api';

// Precise cache updates of the outline: every mutation answers with the changed row and the builder patches the
// cached outline in place (never refetches it). All of these are pure functions of the outline, so they are
// unit tested without a browser.

export const moduleOf = (o: OutlineDto, id: string) => o.modules.find((m) => m.id === id);

/** The id the entry at `to` must go AFTER once it has left `from` (null = first). */
export function afterIdFor(ids: readonly string[], from: number, to: number): string | null {
  const rest = ids.filter((_, i) => i !== from);
  return to <= 0 ? null : (rest[to - 1] ?? null);
}

export function arrayMove<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  const [x] = copy.splice(from, 1);
  if (x !== undefined) copy.splice(Math.max(0, Math.min(to, copy.length)), 0, x);
  return copy;
}

/** Inserts `entry` after the entry `after` (null = first, undefined = end). */
function insertAfter<T extends { id: string }>(
  list: readonly T[],
  entry: T,
  after: string | null | undefined,
): T[] {
  if (after === undefined) return [...list, entry];
  if (after === null) return [entry, ...list];
  const i = list.findIndex((x) => x.id === after);
  return i < 0 ? [...list, entry] : [...list.slice(0, i + 1), entry, ...list.slice(i + 1)];
}

const toOutlineItem = (i: ItemDto): OutlineItem => ({
  id: i.id,
  moduleId: i.moduleId,
  kind: i.kind,
  title: i.title,
  published: i.published,
  availableFrom: i.availableFrom,
  locked: i.locked,
  url: i.url,
  file: i.file,
  hasBody: i.body !== null,
});

export function withModule(
  o: OutlineDto,
  m: ModuleDto,
  after: string | null | undefined,
): OutlineDto {
  const entry: OutlineModule = { ...m, items: [] };
  return { ...o, modules: insertAfter(o.modules, entry, after) };
}

export function withModuleChanged(o: OutlineDto, m: ModuleDto): OutlineDto {
  return { ...o, modules: o.modules.map((x) => (x.id === m.id ? { ...x, ...m } : x)) };
}

export function withModuleMoved(o: OutlineDto, id: string, after: string | null): OutlineDto {
  const m = moduleOf(o, id);
  if (!m) return o;
  return {
    ...o,
    modules: insertAfter(
      o.modules.filter((x) => x.id !== id),
      m,
      after,
    ),
  };
}

export function withoutModule(o: OutlineDto, id: string): OutlineDto {
  return { ...o, modules: o.modules.filter((x) => x.id !== id) };
}

export function withItem(
  o: OutlineDto,
  item: ItemDto,
  after: string | null | undefined,
): OutlineDto {
  return {
    ...o,
    modules: o.modules.map((m) =>
      m.id === item.moduleId
        ? { ...m, items: insertAfter(m.items, toOutlineItem(item), after) }
        : m,
    ),
  };
}

export function withItemChanged(o: OutlineDto, item: ItemDto): OutlineDto {
  return {
    ...o,
    modules: o.modules.map((m) => ({
      ...m,
      items: m.items.map((x) => (x.id === item.id ? toOutlineItem(item) : x)),
    })),
  };
}

/** Moves an item to `toModule` after `after`. */
export function withItemMoved(
  o: OutlineDto,
  itemId: string,
  toModule: string,
  after: string | null,
): OutlineDto {
  let moved: OutlineItem | undefined;
  for (const m of o.modules) moved ??= m.items.find((x) => x.id === itemId);
  if (!moved) return o;
  const item = { ...moved, moduleId: toModule };
  return {
    ...o,
    modules: o.modules.map((m) => {
      const without = m.items.filter((x) => x.id !== itemId);
      return m.id === toModule
        ? { ...m, items: insertAfter(without, item, after) }
        : { ...m, items: without };
    }),
  };
}

export function withoutItem(o: OutlineDto, itemId: string): OutlineDto {
  return {
    ...o,
    modules: o.modules.map((m) => ({ ...m, items: m.items.filter((x) => x.id !== itemId) })),
  };
}

/** Applies `fn` to the cached outline of an offering (nothing happens when it is not cached). */
export function patchOutline(
  qc: QueryClient,
  offeringId: string,
  fn: (o: OutlineDto) => OutlineDto,
): void {
  qc.setQueryData<OutlineDto>(courseKeys.outline(offeringId), (old) => (old ? fn(old) : old));
}
