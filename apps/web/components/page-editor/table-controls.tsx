'use client';

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Plus } from 'lucide-react';

/**
 * Notion-style table affordances: a "+" on the table's right edge adds a
 * column, a "+" on the bottom edge adds a row. Shown only while the cursor is
 * inside a table. Positioned from the live table's bounding rect (recomputed
 * on selection change + scroll/resize) rather than via a NodeView, so it stays
 * decoupled from prosemirror-tables' own DOM/resize handling.
 *
 * Buttons use onMouseDown + preventDefault so the editor keeps its selection
 * (otherwise the click would blur the active cell before the command runs);
 * add is relative to the current cell, which is how you grow the table.
 */
export function TableControls({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      inTable: editor.isActive('table'),
      from: editor.state.selection.from,
    }),
  });
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!state.inTable) {
      setRect(null);
      return;
    }
    const compute = () => {
      try {
        const dom = editor.view.domAtPos(editor.state.selection.from)?.node;
        const el = (dom instanceof HTMLElement ? dom : (dom?.parentElement ?? null)) ?? null;
        const table = el?.closest('table');
        setRect(table ? table.getBoundingClientRect() : null);
      } catch {
        setRect(null);
      }
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [state.inTable, state.from, editor]);

  if (!rect) return null;

  const btn =
    'fixed z-30 flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground';

  return (
    <>
      <button
        type="button"
        aria-label="Add column"
        className={btn}
        style={{ left: rect.right + 4, top: rect.top + rect.height / 2 - 14 }}
        onMouseDown={(e) => {
          e.preventDefault();
          editor.chain().focus().addColumnAfter().run();
        }}
      >
        <Plus className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Add row"
        className={btn}
        style={{ left: rect.left + rect.width / 2 - 14, top: rect.bottom + 4 }}
        onMouseDown={(e) => {
          e.preventDefault();
          editor.chain().focus().addRowAfter().run();
        }}
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </>
  );
}
