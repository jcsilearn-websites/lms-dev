import type { ReactNode } from 'react';

// Renders the server's validated document tree as React elements. No HTML string is ever built or injected:
// every piece of text is a React text node (escaped by React), and only the nodes and marks of the editor's
// vocabulary are drawn. An unknown node is skipped, so even a bad document cannot add markup. Links are
// checked again here (http, https, mailto) although the server already refuses anything else.

export interface RichNode {
  type?: unknown;
  attrs?: Record<string, unknown> | undefined;
  content?: unknown;
  text?: unknown;
  marks?: unknown;
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The href when it is an absolute http(s) / mailto address, else null. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  try {
    return LINK_PROTOCOLS.has(new URL(raw).protocol) ? raw : null;
  } catch {
    return null;
  }
}

const kids = (n: RichNode): RichNode[] =>
  Array.isArray(n.content) ? (n.content as RichNode[]) : [];

function renderText(n: RichNode, key: number): ReactNode {
  if (typeof n.text !== 'string') return null;
  let out: ReactNode = n.text;
  const marks = Array.isArray(n.marks)
    ? (n.marks as { type?: unknown; attrs?: { href?: unknown } }[])
    : [];
  for (const m of marks) {
    if (m.type === 'bold') out = <strong>{out}</strong>;
    else if (m.type === 'italic') out = <em>{out}</em>;
    else if (m.type === 'code')
      out = <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{out}</code>;
    else if (m.type === 'link') {
      const href = safeHref(m.attrs?.href);
      if (href) {
        out = (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline"
          >
            {out}
          </a>
        );
      }
    }
  }
  return <span key={key}>{out}</span>;
}

function renderBlock(n: RichNode, key: number): ReactNode {
  const children = () => kids(n).map((c, i) => renderBlock(c, i));
  const inline = () => kids(n).map((c, i) => renderText(c, i));
  switch (n.type) {
    case 'paragraph':
      return (
        <p key={key} className="my-3">
          {inline()}
        </p>
      );
    case 'heading':
      return n.attrs?.level === 3 ? (
        <h3 key={key} className="mb-2 mt-5 text-lg font-semibold">
          {inline()}
        </h3>
      ) : (
        <h2 key={key} className="mb-2 mt-6 text-xl font-semibold">
          {inline()}
        </h2>
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="my-3 border-l-4 border-border pl-4 text-muted-foreground">
          {children()}
        </blockquote>
      );
    case 'bulletList':
      return (
        <ul key={key} className="my-3 list-disc pl-6">
          {children()}
        </ul>
      );
    case 'orderedList': {
      const start = n.attrs?.start;
      return (
        <ol
          key={key}
          className="my-3 list-decimal pl-6"
          {...(typeof start === 'number' ? { start } : {})}
        >
          {children()}
        </ol>
      );
    }
    case 'listItem':
      return <li key={key}>{children()}</li>;
    default:
      return null;
  }
}

/** The text of an item. `doc` is the stored tree (validated by the server). */
export function RichTextView({ doc }: { doc: unknown }) {
  const root = doc as RichNode | null;
  if (root?.type !== 'doc') return null;
  return (
    <div className="max-w-prose break-words">{kids(root).map((n, i) => renderBlock(n, i))}</div>
  );
}

/** Plain text of a document (search, previews, tests). */
export function plainText(doc: unknown): string {
  const walk = (n: RichNode): string =>
    typeof n.text === 'string'
      ? n.text
      : kids(n)
          .map(walk)
          .join(n.type === 'doc' ? '\n' : '');
  return doc && typeof doc === 'object' ? walk(doc as RichNode) : '';
}
