'use client';

import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import type { EditorProps } from '@tiptap/pm/view';
import { pageExtensions } from './extensions';
import { EditorBubbleMenu } from './bubble-menu';
import { EditorDragHandle } from './drag-handle';
import { TableControls } from './table-controls';
import { SlashCommand } from './slash-command';
import { FocusMarks, focusMarksKey } from './focus-marks';
import { FocusGutter } from './focus-gutter';
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
  pageId,
  markerMode = false,
  marks,
  editedIds,
  onMarksChange,
  onChange,
  onBlur,
  onEditorReady,
  editable = true,
}: {
  content: JSONContent;
  /** Id of the page being edited — handed to the `/page` slash command so the
   *  sub-pages it creates get `parent_id` set to this page (Phase 4a). */
  pageId?: string | null;
  /** When true the left gutter becomes a focus-marker strip (and the drag
   *  handle steps aside). The marks themselves stay highlighted regardless. */
  markerMode?: boolean;
  /** Block ids currently marked for Pages to focus on. Source of truth lives in
   *  the parent (persisted to localStorage); we just render + collect. */
  marks?: string[];
  /** Block ids Pages changed in the current draft — highlighted green so the
   *  user can see what moved after a run. Cleared on commit. */
  editedIds?: string[];
  /** The gutter computed a new marked set (drag range / click toggle). */
  onMarksChange?: (ids: string[]) => void;
  onChange: (doc: JSONContent) => void;
  /** Editor lost focus — a natural "settle" signal to flush / re-index. */
  onBlur?: () => void;
  /** Hands the editor instance up once ready (e.g. so the title can move focus
   *  into the body on Enter). */
  onEditorReady?: (editor: Editor) => void;
  /** Toggle write access. Used by the AI-assist panel to lock the editor
   *  while Pages is running — prevents the race where user typing lands
   *  in `draft_doc` via autosave while the agent is mid-compute, then
   *  gets clobbered by the agent's saveDraft at the end. */
  editable?: boolean;
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
    // SlashCommand + FocusMarks are editor-only (no schema / no doc writes), so
    // PageView stays identical. SlashCommand carries the page id so `/page`
    // parents sub-pages here.
    extensions: [...pageExtensions, SlashCommand.configure({ pageId: pageId ?? null }), FocusMarks],
    content,
    immediatelyRender: false, // required for Next.js SSR (avoids hydration mismatch)
    editorProps,
    // Guard on docChanged so meta-only transactions (e.g. pushing focus marks)
    // never look like an edit — otherwise marking a section would trip autosave.
    onUpdate: ({ editor, transaction }) => {
      if (transaction.docChanged) onChangeRef.current(editor.getJSON());
    },
    onBlur: () => onBlurRef.current?.(),
  });

  useEffect(() => {
    editorRef.current = editor;
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  // Sync TipTap's editable flag with the prop. setEditable also re-renders
  // the view so the contenteditable attribute + selection handling update.
  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  // Push the marked + edited block-id sets into the FocusMarks plugin
  // (meta-only — no doc change, so no autosave). Re-runs whenever either set
  // changes (incl. after the AI-change editor remount, which re-seeds them).
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(focusMarksKey, { marked: marks ?? [], edited: editedIds ?? [] }),
    );
  }, [editor, marks, editedIds]);

  if (!editor) return null;

  return (
    <>
      <EditorBubbleMenu editor={editor} />
      {/* Marker mode swaps the gutter's job: the drag handle steps aside so the
          focus strip owns the left band. Marks stay highlighted either way. */}
      {markerMode ? null : <EditorDragHandle editor={editor} />}
      <TableControls editor={editor} />
      <div className="relative">
        {markerMode && onMarksChange && (
          <FocusGutter editor={editor} marks={marks ?? []} onChange={onMarksChange} />
        )}
        <EditorContent editor={editor} />
      </div>
    </>
  );
}
