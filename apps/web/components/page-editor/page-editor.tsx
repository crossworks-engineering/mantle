'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import type { EditorProps } from '@tiptap/pm/view';
import { pageExtensions } from './extensions';
import { nodeHref } from '@/lib/node-href';
import { EditorBubbleMenu } from './bubble-menu';
import { EditorDragHandle } from './drag-handle';
import { TableControls } from './table-controls';
import { SlashCommand } from './slash-command';
import { FocusMarks, focusMarksKey } from './focus-marks';
import { FocusGutter } from './focus-gutter';
import { DiffReview, diffReviewKey, DIFF_ACTION_EVENT } from './diff-review';
import { handleDroppedFiles } from './upload';
import type { DiffOverlay } from '@mantle/content/page-diff';

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
  diff,
  onDiffAction,
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
  /** Visual-diff overlay for review mode (added/changed/removed). Null = no
   *  review (normal editing). When set, the editor paints borders + removed
   *  ghosts + per-block Discard/Restore controls. */
  diff?: DiffOverlay | null;
  /** A per-block diff control was pressed (Discard a change / Restore a removed
   *  block). The host does the doc surgery + recomputes the overlay. */
  onDiffAction?: (action: 'discard' | 'restore', id: string) => void;
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
  // Router kept in a ref so the once-bound (memoized []) click handler can
  // navigate without re-creating editorProps (which would churn the view).
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  // Holds the editor for the once-bound drop/paste handlers (they're defined in
  // the useEditor config, before `editor` is assigned).
  const editorRef = useRef<Editor | null>(null);
  const onDiffActionRef = useRef(onDiffAction);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onReadyRef.current = onEditorReady;
    onDiffActionRef.current = onDiffAction;
  }, [onChange, onBlur, onEditorReady, onDiffAction]);

  // Stable editorProps. useEditor re-applies editor.setOptions() on every render
  // when its options compare unequal, and a fresh editorProps object each render
  // makes them unequal — that setOptions churns the view and drops an open slash/
  // mention popup (e.g. when the idle autosave re-renders). The drop/paste
  // handlers read editorRef at call time, so [] deps are safe.
  const editorProps = useMemo<EditorProps>(
    () => ({
      attributes: {
        // `page-gutter` carries the left-gutter padding (drag handle / focus
        // marker) and stays put even when the editor is locked during an AI
        // run — scoping it to [contenteditable='true'] dropped the padding the
        // moment setEditable(false) fired, sliding text under the gutter.
        class: 'page-gutter prose dark:prose-invert prose-accent max-w-none min-h-[50vh] focus:outline-none',
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
      // Click a node-link @-mention (ref:'node') → navigate to that page/note.
      // DOM-based (not handleClickOn): ProseMirror resolves an inline-atom click
      // to the parent paragraph, so we read the chip element off the event. Entity
      // mentions have no route, so they fall through to normal selection.
      handleClick: (_view, _pos, event) => {
        const chip = (event.target as HTMLElement | null)?.closest?.(
          '.mention[data-ref="node"]',
        ) as HTMLElement | null;
        if (!chip) return false;
        const href = nodeHref(chip.getAttribute('data-kind'), chip.getAttribute('data-id') ?? '');
        if (!href) return false;
        event.preventDefault();
        routerRef.current.push(href);
        return true;
      },
    }),
    [],
  );

  const editor = useEditor({
    // SlashCommand + FocusMarks are editor-only (no schema / no doc writes), so
    // PageView stays identical. SlashCommand carries the page id so `/page`
    // parents sub-pages here.
    extensions: [
      ...pageExtensions,
      SlashCommand.configure({ pageId: pageId ?? null }),
      FocusMarks,
      DiffReview,
    ],
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

  // Push the visual-diff overlay into the DiffReview plugin (meta-only). Null
  // clears review mode. Re-runs on remount (AI changes) and whenever the host
  // recomputes the overlay (e.g. after a per-block discard/restore).
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(diffReviewKey, diff ?? null));
  }, [editor, diff]);

  // Per-block diff controls dispatch a bubbling CustomEvent; the host does the
  // doc surgery. Listen on the editor DOM (the buttons live inside it).
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent<{ action: 'discard' | 'restore'; id: string }>).detail;
      if (detail?.id) onDiffActionRef.current?.(detail.action, detail.id);
    };
    dom.addEventListener(DIFF_ACTION_EVENT, onAction);
    return () => dom.removeEventListener(DIFF_ACTION_EVENT, onAction);
  }, [editor]);

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
