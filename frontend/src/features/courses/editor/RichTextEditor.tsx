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
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react';
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
    // This component does not re-render per transaction (typing): only the toolbar follows the editor state
    // (useEditorState in EditorToolbar), so the editing area is not rebuilt on every keystroke.
    shouldRerenderOnTransaction: false,
  });
  if (!editor)
    return <div className="min-h-40 rounded-md border border-input" aria-hidden="true" />;

  return (
    <div className="rich-editor">
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  link: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const sameToolbarState = (a: ToolbarState, b: ToolbarState | null) =>
  b !== null && (Object.keys(a) as (keyof ToolbarState)[]).every((k) => a[k] === b[k]);

// The toolbar subscribes to just the flags it shows: it re-renders when one of them changes (aria-pressed and
// disabled stay correct), the editing area does not re-render at all.
function EditorToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('https://');
  const st = useEditorState({
    editor,
    selector: ({ editor: e }): ToolbarState => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      code: e.isActive('code'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
    equalityFn: sameToolbarState,
  });
  const run = (fn: () => boolean) => () => {
    fn();
  };
  const applyLink = () => {
    const url = href.trim();
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkOpen(false);
  };
  return (
    <>
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="flex flex-wrap gap-1 rounded-t-md border border-b-0 border-input bg-muted p-1"
      >
        <button
          type="button"
          className={btn}
          aria-pressed={st.bold}
          onClick={run(() => editor.chain().focus().toggleBold().run())}
        >
          <strong>Bold</strong>
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.italic}
          onClick={run(() => editor.chain().focus().toggleItalic().run())}
        >
          <em>Italic</em>
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.code}
          onClick={run(() => editor.chain().focus().toggleCode().run())}
        >
          Code
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.h2}
          onClick={run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        >
          Heading 2
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.h3}
          onClick={run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
        >
          Heading 3
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.bulletList}
          onClick={run(() => editor.chain().focus().toggleBulletList().run())}
        >
          Bulleted list
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.orderedList}
          onClick={run(() => editor.chain().focus().toggleOrderedList().run())}
        >
          Numbered list
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.blockquote}
          onClick={run(() => editor.chain().focus().toggleBlockquote().run())}
        >
          Quote
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={st.link}
          onClick={() => setLinkOpen((o) => !o)}
        >
          Link
        </button>
        <button
          type="button"
          className={btn}
          disabled={!st.canUndo}
          onClick={run(() => editor.chain().focus().undo().run())}
        >
          Undo
        </button>
        <button
          type="button"
          className={btn}
          disabled={!st.canRedo}
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
    </>
  );
}
