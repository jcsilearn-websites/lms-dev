import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import BulletList from '@tiptap/extension-bullet-list';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import Heading from '@tiptap/extension-heading';
import History from '@tiptap/extension-history';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import ListItem from '@tiptap/extension-list-item';
import OrderedList from '@tiptap/extension-ordered-list';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import { useState } from 'react';
import { cn } from '../../../shared/utils/cn';

// The rich-text editor. THIS FILE IS ITS OWN CHUNK: it is loaded only by the course builder (and prefetched in
// idle time once the builder has loaded), never by the sign-in, learner or admin screens (a bundle test proves
// it). The extension set is exactly the server's vocabulary (content.richtext.ts): anything else the editor could
// produce would be refused by the API.

const EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [2, 3] }),
  Bold,
  Italic,
  Code,
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  Link.configure({
    openOnClick: false,
    autolink: false,
    protocols: ['http', 'https', 'mailto'],
    // the server stores only the address; these attributes are decoration of the editing view
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
  }),
  History,
];

const btn =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-input px-2 text-sm hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground sm:min-h-9 sm:min-w-9';

export interface RichTextEditorProps {
  /** The stored document (ProseMirror JSON) or null for an empty one. */
  value: unknown;
  /** Called with the document JSON after every change. */
  onChange: (doc: unknown) => void;
  /** Accessible name of the editing area. */
  label: string;
}

export default function RichTextEditor({ value, onChange, label }: RichTextEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('https://');
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: (value as object | null) ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        class:
          'min-h-40 max-w-none rounded-b-md border border-input bg-surface px-3 py-2 focus:outline-2 focus:outline-offset-2 focus:outline-primary',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON()),
    immediatelyRender: false,
  });
  if (!editor)
    return <div className="min-h-40 rounded-md border border-input" aria-hidden="true" />;

  const run = (fn: () => boolean) => () => {
    fn();
  };
  const applyLink = () => {
    const url = href.trim();
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkOpen(false);
  };
  return (
    <div className="rich-editor">
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="flex flex-wrap gap-1 rounded-t-md border border-b-0 border-input bg-muted p-1"
      >
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('bold')}
          onClick={run(() => editor.chain().focus().toggleBold().run())}
        >
          <strong>Bold</strong>
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('italic')}
          onClick={run(() => editor.chain().focus().toggleItalic().run())}
        >
          <em>Italic</em>
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('code')}
          onClick={run(() => editor.chain().focus().toggleCode().run())}
        >
          Code
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('heading', { level: 2 })}
          onClick={run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        >
          Heading 2
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('heading', { level: 3 })}
          onClick={run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
        >
          Heading 3
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('bulletList')}
          onClick={run(() => editor.chain().focus().toggleBulletList().run())}
        >
          Bulleted list
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('orderedList')}
          onClick={run(() => editor.chain().focus().toggleOrderedList().run())}
        >
          Numbered list
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('blockquote')}
          onClick={run(() => editor.chain().focus().toggleBlockquote().run())}
        >
          Quote
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={editor.isActive('link')}
          onClick={() => setLinkOpen((o) => !o)}
        >
          Link
        </button>
        <button
          type="button"
          className={btn}
          disabled={!editor.can().undo()}
          onClick={run(() => editor.chain().focus().undo().run())}
        >
          Undo
        </button>
        <button
          type="button"
          className={btn}
          disabled={!editor.can().redo()}
          onClick={run(() => editor.chain().focus().redo().run())}
        >
          Redo
        </button>
      </div>
      {linkOpen && (
        <div className="flex flex-wrap items-end gap-2 border border-b-0 border-input bg-surface p-2">
          <label className="min-w-0 flex-1 text-sm">
            <span className="mb-1 block font-medium">Link address</span>
            <input
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                }
              }}
              inputMode="url"
              className="min-h-11 w-full rounded-md border border-input bg-surface px-3 sm:min-h-9"
            />
          </label>
          <button type="button" className={cn(btn, 'px-3')} onClick={applyLink}>
            Apply link
          </button>
          <button
            type="button"
            className={cn(btn, 'px-3')}
            onClick={() => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
              setLinkOpen(false);
            }}
          >
            Remove link
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
