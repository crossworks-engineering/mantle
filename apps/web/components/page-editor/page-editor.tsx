'use client';

import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import type { EditorProps } from '@tiptap/pm/view';
import { pageExtensions } from './extensions';
import { EditorBubbleMenu } from './bubble-menu';
import { EditorDragHandle } from './drag-handle';
import { TableControls } from './table-controls';
import { SlashCommand } from './slash-command';
import { handleDroppedFiles } from './upload';

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
  // Holds the editor for the once-bound drop/paste handlers (they're defined in
  // the useEditor config, before `editor` is assigned).
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onReadyRef.current = onEditorReady;
  }, [onChange, onBlur, onEditorReady]);

  // Stable editorProps. useEditor re-applies editor.setOptions() on every render
  // when its options compare unequal, and a fresh editorProps object each render
  // makes them unequal — that setOptions churns the view and drops an open slash/
  // mention popup (e.g. when the idle autosave re-renders). The drop/paste
  // handlers read editorRef at call time, so [] deps are safe.
  const editorProps = useMemo<EditorProps>(
    () => ({
      attributes: {
        class: 'prose dark:prose-invert max-w-none min-h-[50vh] focus:outline-none',
      },
      // Drop images/files onto the canvas → upload + insert at the drop point.
      handleDrop: (view, event) => {
        const dt = (event as DragEvent).dataTransfer;
        const files = Array.from(dt?.files ?? []);
        if (files.length === 0) return false;
        const pos = view.posAtCoords({
          left: (event as DragEvent).clientX,
          top: (event as DragEvent).clientY,
        })?.pos;
        if (!editorRef.current) return false;
        return handleDroppedFiles(editorRef.current, files, pos);
      },
      // Paste an image/file from the clipboard → upload + insert.
      handlePaste: (_view, event) => {
        const files = Array.from((event as ClipboardEvent).clipboardData?.files ?? []);
        if (files.length === 0) return false;
        if (!editorRef.current) return false;
        return handleDroppedFiles(editorRef.current, files);
      },
    }),
    [],
  );

  const editor = useEditor({
    // SlashCommand is editor-only (no schema), so PageView stays identical.
    extensions: [...pageExtensions, SlashCommand],
    content,
    immediatelyRender: false, // required for Next.js SSR (avoids hydration mismatch)
    editorProps,
    onUpdate: ({ editor }) => onChangeRef.current(editor.getJSON()),
    onBlur: () => onBlurRef.current?.(),
  });

  useEffect(() => {
    editorRef.current = editor;
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  if (!editor) return null;

  return (
    <>
      <EditorBubbleMenu editor={editor} />
      <EditorDragHandle editor={editor} />
      <TableControls editor={editor} />
      <EditorContent editor={editor} />
    </>
  );
}
