'use client';

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Plus, Trash2 } from 'lucide-react';

/**
 * Notion-style table affordances, shown only while the cursor is inside a table:
 *  - a "+" on the right edge adds a column, a "+" on the bottom edge adds a row
 *    (relative to the current cell, which is how you grow the table);
 *  - a trash handle on the left edge deletes the current row, and one on the top
 *    edge deletes the current column. Delete handles align to the ACTIVE cell so
 *    it's clear which row/column goes, and they hide when only one row/column is
 *    left (deleting the last one would leave a broken table — grow it or delete
 *    the whole table from the block drag-handle instead).
 *
 * Positioned from the live table's / active cell's bounding rects (recomputed on
 * selection change + scroll/resize) rather than via a NodeView, so it stays
 * decoupled from prosemirror-tables' own DOM/resize handling.
 *
 * Buttons use onMouseDown + preventDefault so the editor keeps its selection
 * (otherwise the click would blur the active cell before the command runs); the
 * add/delete commands all act on the current cell's row/column.
 */
type Geom = { table: DOMRect; cell: DOMRect; rows: number; cols: number };

export function TableControls({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      inTable: editor.isActive('table'),
      from: editor.state.selection.from,
    }),
  });
  const [geom, setGeom] = useState<Geom | null>(null);

  // Only surface the controls while the editor is actually focused. On load the
  // default selection sits at the document start, so a page whose first block is
  // a table would otherwise show the handles before the user ever clicks in.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    setFocused(editor.isFocused);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    return () => {
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
    };
  }, [editor]);

  useEffect(() => {
    if (!state.inTable || !focused) {
      setGeom(null);
      return;
    }
    const compute = () => {
      try {
        const dom = editor.view.domAtPos(editor.state.selection.from)?.node;
        const el = (dom instanceof HTMLElement ? dom : (dom?.parentElement ?? null)) ?? null;
        const table = el?.closest('table');
        const cell = el?.closest('td,th');
        if (!table || !cell) {
          setGeom(null);
          return;
        }
        const rowEls = table.querySelectorAll('tr');
        setGeom({
          table: table.getBoundingClientRect(),
          cell: cell.getBoundingClientRect(),
          rows: rowEls.length,
          cols: rowEls[0]?.children.length ?? 0,
        });
      } catch {
        setGeom(null);
      }
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [state.inTable, state.from, focused, editor]);

  if (!geom) return null;
  const { table, cell, rows, cols } = geom;

  // size-7 == 28px; -14 centres a handle on an edge/axis.
  const btn =
    'fixed z-30 flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground';
  const delBtn =
    'fixed z-30 flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-destructive/10 hover:text-destructive';

  // Delete the current row/column; if that leaves the table with no content at
  // all, drop the whole table rather than stranding a blank grid.
  const deleteAndPrune = (isRow: boolean) => {
    const chain = editor.chain().focus();
    (isRow ? chain.deleteRow() : chain.deleteColumn()).run();
    const { $from } = editor.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'table') {
        if (node.textContent.trim() === '') editor.chain().focus().deleteTable().run();
        break;
      }
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Add column"
        title="Add column"
        className={btn}
        style={{ left: table.right + 4, top: table.top + table.height / 2 - 14 }}
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
        title="Add row"
        className={btn}
        style={{ left: table.left + table.width / 2 - 14, top: table.bottom + 4 }}
        onMouseDown={(e) => {
          e.preventDefault();
          editor.chain().focus().addRowAfter().run();
        }}
      >
        <Plus className="size-4" aria-hidden />
      </button>
      {rows > 1 && (
        <button
          type="button"
          aria-label="Delete row"
          title="Delete row"
          className={delBtn}
          style={{ left: table.left - 4 - 28, top: cell.top + cell.height / 2 - 14 }}
          onMouseDown={(e) => {
            e.preventDefault();
            deleteAndPrune(true);
          }}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      )}
      {cols > 1 && (
        <button
          type="button"
          aria-label="Delete column"
          title="Delete column"
          className={delBtn}
          style={{ left: cell.left + cell.width / 2 - 14, top: table.top - 4 - 28 }}
          onMouseDown={(e) => {
            e.preventDefault();
            deleteAndPrune(false);
          }}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      )}
    </>
  );
}
