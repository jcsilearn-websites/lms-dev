// Rich text is stored and served as a document TREE, never as HTML. This is the allowlist: exactly the nodes
// and marks of the editor's extension set (Document, Paragraph, Text, Heading 2-3, Bold, Italic, Code,
// Blockquote, BulletList, OrderedList, ListItem, Link). Anything else is refused, and what is accepted is
// REBUILT here (unknown attributes dropped), so what is stored is exactly what we understand.

export type RichNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

export interface RichTextProblem {
  path: string;
  message: string;
}

const LIMITS = { depth: 8, nodes: 5000, text: 20_000, href: 2000 } as const;
const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList']);
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** A link target: an absolute http(s) or mailto URL, nothing else (no javascript:, data:, relative paths). */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LIMITS.href) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    return LINK_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates a document and returns its canonical form, or the problems found. `doc` with no content is a
 * valid empty document.
 */
export function normalizeRichText(
  input: unknown,
): { ok: true; doc: RichNode } | { ok: false; problems: RichTextProblem[] } {
  const problems: RichTextProblem[] = [];
  let nodes = 0;
  const bad = (path: string, message: string) => {
    if (problems.length < 20) problems.push({ path, message });
  };

  function inline(raw: unknown, path: string): RichNode | null {
    if (!isObject(raw) || raw.type !== 'text') {
      bad(path, 'only text is allowed inside a paragraph or heading');
      return null;
    }
    if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > LIMITS.text) {
      bad(path, 'text must be 1 to 20000 characters');
      return null;
    }
    const marks: NonNullable<RichNode['marks']> = [];
    for (const [i, m] of (Array.isArray(raw.marks) ? raw.marks : []).entries()) {
      const mp = `${path}.marks[${i}]`;
      if (!isObject(m)) {
        bad(mp, 'a mark must be an object');
        continue;
      }
      if (m.type === 'bold' || m.type === 'italic' || m.type === 'code') {
        marks.push({ type: m.type });
      } else if (m.type === 'link') {
        const href = safeHref(isObject(m.attrs) ? m.attrs.href : undefined);
        if (!href) bad(mp, 'a link must be an http, https or mailto address');
        else marks.push({ type: 'link', attrs: { href } });
      } else {
        bad(mp, `the mark "${String(m.type)}" is not allowed`);
      }
    }
    return marks.length > 0
      ? { type: 'text', text: raw.text, marks }
      : { type: 'text', text: raw.text };
  }

  function children(
    raw: unknown,
    path: string,
    depth: number,
    kind: 'inline' | 'block' | 'li',
  ): RichNode[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      bad(path, 'content must be a list');
      return [];
    }
    const out: RichNode[] = [];
    for (const [i, c] of raw.entries()) {
      const p = `${path}[${i}]`;
      const n = kind === 'inline' ? inline(c, p) : block(c, p, depth, kind === 'li');
      if (n) out.push(n);
    }
    return out;
  }

  function block(
    raw: unknown,
    path: string,
    depth: number,
    listItemOnly: boolean,
  ): RichNode | null {
    if (++nodes > LIMITS.nodes) {
      bad(path, 'the document is too large');
      return null;
    }
    if (depth > LIMITS.depth) {
      bad(path, 'the document is nested too deeply');
      return null;
    }
    if (!isObject(raw) || typeof raw.type !== 'string') {
      bad(path, 'a node must be an object with a type');
      return null;
    }
    const type = raw.type;
    if (listItemOnly) {
      if (type !== 'listItem') {
        bad(path, 'a list can only contain list items');
        return null;
      }
      return { type, content: children(raw.content, `${path}.content`, depth + 1, 'block') };
    }
    if (!BLOCKS.has(type)) {
      bad(path, `the node "${type}" is not allowed`);
      return null;
    }
    const content = raw.content;
    switch (type) {
      case 'paragraph':
        return withContent('paragraph', children(content, `${path}.content`, depth + 1, 'inline'));
      case 'heading': {
        const level = isObject(raw.attrs) ? raw.attrs.level : undefined;
        if (level !== 2 && level !== 3) {
          bad(`${path}.attrs.level`, 'a heading is level 2 or 3');
          return null;
        }
        return {
          type,
          attrs: { level },
          ...asContent(children(content, `${path}.content`, depth + 1, 'inline')),
        };
      }
      case 'blockquote':
        return withContent('blockquote', children(content, `${path}.content`, depth + 1, 'block'));
      case 'bulletList':
        return withContent('bulletList', children(content, `${path}.content`, depth + 1, 'li'));
      default: {
        // orderedList
        const start = isObject(raw.attrs) ? raw.attrs.start : undefined;
        const attrs =
          Number.isInteger(start) && (start as number) >= 1 && (start as number) <= 1_000_000
            ? { start: start as number }
            : undefined;
        return {
          type,
          ...(attrs ? { attrs } : {}),
          ...asContent(children(content, `${path}.content`, depth + 1, 'li')),
        };
      }
    }
  }

  const asContent = (c: RichNode[]) => (c.length > 0 ? { content: c } : {});
  const withContent = (type: string, c: RichNode[]): RichNode => ({ type, ...asContent(c) });

  if (!isObject(input) || input.type !== 'doc') {
    return { ok: false, problems: [{ path: '', message: 'the document must be of type "doc"' }] };
  }
  const content = children(input.content, 'content', 1, 'block');
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, doc: { type: 'doc', ...asContent(content) } };
}
