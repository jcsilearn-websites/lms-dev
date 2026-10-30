import { describe, expect, it } from 'vitest';
import { normalizeRichText, safeHref } from '../content.richtext';

const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string, marks?: unknown[]) => ({
  type: 'text',
  text: t,
  ...(marks ? { marks } : {}),
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const problems = (input: unknown) => {
  const r = normalizeRichText(input);
  return r.ok ? [] : r.problems.map((x) => x.message);
};

describe('safeHref: only absolute http, https and mailto', () => {
  it.each([
    ['https://example.org/a?b=1#c', 'https://example.org/a?b=1#c'],
    ['http://example.org', 'http://example.org/'],
    ['mailto:someone@example.org', 'mailto:someone@example.org'],
  ])('accepts %s', (raw, out) => expect(safeHref(raw)).toBe(out));

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html;base64,AAAA',
    'vbscript:x',
    'file:///etc/passwd',
    'ftp://example.org',
    '//example.org',
    '/relative/path',
    'example.org',
    '',
    `https://example.org/${'a'.repeat(2100)}`,
  ])('refuses %j', (raw) => expect(safeHref(raw)).toBeNull());

  it('refuses things that are not strings', () => {
    for (const v of [null, undefined, 42, {}, ['https://a.b']]) expect(safeHref(v)).toBeNull();
  });
});

describe('normalizeRichText', () => {
  it('accepts an empty document and the full editor vocabulary, and rebuilds it', () => {
    expect(normalizeRichText({ type: 'doc' })).toEqual({ ok: true, doc: { type: 'doc' } });
    const full = doc(
      { type: 'heading', attrs: { level: 3, x: 1 }, content: [text('H')] },
      p(text('a', [{ type: 'bold' }, { type: 'italic' }, { type: 'code' }])),
      {
        type: 'orderedList',
        attrs: { start: 3, junk: true },
        content: [{ type: 'listItem', content: [p(text('1'))] }],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('b'))] }] },
      { type: 'blockquote', content: [p(text('q'))] },
    );
    const r = normalizeRichText(full);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.stringify(r.doc)).not.toContain('junk');
      expect(r.doc.content?.[0]).toEqual({
        type: 'heading',
        attrs: { level: 3 },
        content: [text('H')],
      });
      expect(r.doc.content?.[2]?.attrs).toEqual({ start: 3 });
    }
  });

  it('keeps only href on a link and normalises it', () => {
    const r = normalizeRichText(
      doc(
        p(
          text('x', [
            {
              type: 'link',
              attrs: { href: 'HTTPS://Example.org', target: '_blank', rel: 'x', class: 'y' },
            },
          ]),
        ),
      ),
    );
    expect(r.ok && r.doc.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.org/' } },
    ]);
  });

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['a different root', { type: 'paragraph' }],
    ['an unknown block', doc({ type: 'iframe', attrs: { src: 'https://x' } })],
    ['html as text node type', doc({ type: 'html', text: '<b>x</b>' })],
    ['an image', doc({ type: 'image', attrs: { src: 'x' } })],
    ['a code block', doc({ type: 'codeBlock', content: [text('x')] })],
    ['a hard break inside a paragraph', doc(p({ type: 'hardBreak' }))],
    ['heading level 1', doc({ type: 'heading', attrs: { level: 1 }, content: [] })],
    ['heading level as string', doc({ type: 'heading', attrs: { level: '2' }, content: [] })],
    ['an underline mark', doc(p(text('x', [{ type: 'underline' }])))],
    ['a style mark', doc(p(text('x', [{ type: 'textStyle', attrs: { color: 'red' } }])))],
    [
      'a javascript link',
      doc(p(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
    ],
    ['a link without href', doc(p(text('x', [{ type: 'link' }])))],
    ['empty text', doc(p(text('')))],
    ['a list holding a paragraph', doc({ type: 'bulletList', content: [p(text('x'))] })],
    ['a list item outside a list', doc({ type: 'listItem', content: [] })],
    ['text where a block belongs', doc(text('x'))],
  ])('refuses %s', (_name, input) => {
    expect(problems(input).length).toBeGreaterThan(0);
  });

  it('treats script-looking text as plain text and leaves it untouched', () => {
    const r = normalizeRichText(doc(p(text('<script>alert(1)</script>'))));
    expect(r.ok && r.doc.content?.[0]?.content?.[0]?.text).toBe('<script>alert(1)</script>');
  });

  it('refuses too deep and too large documents without recursing forever', () => {
    let node: unknown = p(text('x'));
    for (let n = 0; n < 50; n++) node = { type: 'blockquote', content: [node] };
    expect(problems(doc(node)).join()).toContain('deeply');
    expect(problems(doc(...Array.from({ length: 5200 }, () => p()))).join()).toContain('too large');
    expect(problems(doc(p(text('x'.repeat(20_001))))).join()).toContain('20000');
  });
});
