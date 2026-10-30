import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { describe, expect, it, vi } from 'vitest';

// Count the renders of RichTextEditor itself: it calls useEditor once per render.
const seen: { editor: Editor | null; calls: number } = { editor: null, calls: 0 };
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      seen.calls += 1;
      const editor = actual.useEditor(...args);
      seen.editor = editor;
      return editor;
    },
  };
});

import RichTextEditor from '../src/features/courses/editor/RichTextEditor';

describe('RichTextEditor', () => {
  it('typing does not re-render the editor component; only the toolbar follows the marks', async () => {
    render(<RichTextEditor value={null} onChange={() => {}} label="Text of this item" />);
    const bold = await screen.findByRole('button', { name: 'Bold' });
    const editor = seen.editor as Editor;
    expect(editor).toBeTruthy();
    await act(async () => {
      editor.commands.focus();
    });
    expect(bold).toHaveAttribute('aria-pressed', 'false');
    const rendersBefore = seen.calls;

    await act(async () => {
      editor.chain().focus().insertContent('Welcome ').run();
      editor.chain().focus().toggleBold().insertContent('careful').run();
    });

    // the toolbar updated ...
    expect(bold).toHaveAttribute('aria-pressed', 'true');
    // ... the typed text is in the editing area ...
    expect(editor.getHTML()).toContain('<strong>careful</strong>');
    // ... and the editor component was not rendered again
    expect(seen.calls).toBe(rendersBefore);

    await act(async () => {
      editor.chain().focus().toggleBold().run();
    });
    expect(bold).toHaveAttribute('aria-pressed', 'false');
    expect(seen.calls).toBe(rendersBefore);
  });

  it('enables Undo only once there is something to undo', async () => {
    render(<RichTextEditor value={null} onChange={() => {}} label="Text of this item" />);
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo).toBeDisabled();
    await act(async () => {
      (seen.editor as Editor).chain().focus().insertContent('x').run();
    });
    expect(undo).toBeEnabled();
  });

  it('a mouse press on a toolbar button does not take the focus from the editing area', async () => {
    render(<RichTextEditor value={null} onChange={() => {}} label="Text of this item" />);
    const bold = await screen.findByRole('button', { name: 'Bold' });
    // fireEvent returns false when the event was default-prevented (which is what keeps the focus in place)
    expect(fireEvent.mouseDown(bold)).toBe(false);
  });
});
