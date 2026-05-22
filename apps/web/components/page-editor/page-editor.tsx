'use client';

import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { pageExtensions } from './extensions';
import { EditorBubbleMenu } from './bubble-menu';
import { SlashCommand } from './slash-command';

/**
 * The "invisible" editing surface: no border, no card, no fixed toolbar — just
 * text on the page. Formatting comes from markdown shortcuts and the selection
 * bubble menu (and, next slice, the slash menu).
 *
 * `content` is the initial doc (the editor owns its state after). Callbacks are
 * kept in refs so the editor's once-bound handlers always call the latest
 * closures — otherwise a debounced autosave that re-creates them goes stale.
 */
export function PageEditor({
  content,
  onChange,
  onBlur,
  onEditorReady,
}: {
  content: JSONContent;
  onChange: (doc: JSONContent) => void;
  /** Editor lost focus — a natural "settle" signal to flush / re-index. */
  onBlur?: () => void;
  /** Hands the editor instance up once ready (e.g. so the title can move focus
   *  into the body on Enter). */
  onEditorReady?: (editor: Editor) => void;
}) {
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onReadyRef = useRef(onEditorReady);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onReadyRef.current = onEditorReady;
  }, [onChange, onBlur, onEditorReady]);

  const editor = useEditor({
    // SlashCommand is editor-only (no schema), so PageView stays identical.
    extensions: [...pageExtensions, SlashCommand],
    content,
    immediatelyRender: false, // required for Next.js SSR (avoids hydration mismatch)
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none min-h-[50vh] focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getJSON()),
    onBlur: () => onBlurRef.current?.(),
  });

  useEffect(() => {
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  if (!editor) return null;

  return (
    <>
      <EditorBubbleMenu editor={editor} />
      <EditorContent editor={editor} />
    </>
  );
}
