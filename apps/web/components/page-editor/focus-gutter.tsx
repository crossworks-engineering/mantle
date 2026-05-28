'use client';

import { useRef } from 'react';
import type { Editor } from '@tiptap/react';

/**
 * FocusGutter — the interactive half of the gutter focus marker. A thin strip
 * over the editor's left padding band (the same 2.5rem the drag handle lives
 * in). Rendered only when marker mode is on, so normal editing keeps the drag
 * handle.
 *
 * Interactions:
 *   - Drag down the gutter → mark that contiguous run of blocks (added to the
 *     existing set, so you can build up multiple ranges with repeated drags).
 *   - Click a single row → toggle just that block.
 *
 * Block resolution goes straight off the rendered DOM: the editable's direct
 * children ARE the top-level blocks, each carrying `data-block-id` (the BlockId
 * extension). We hit-test by vertical rect, so the strip's x doesn't matter and
 * scrolling never throws it off (clientY and the rects are both viewport-space).
 * Blocks without an id (e.g. a just-typed paragraph the server hasn't id'd yet)
 * are skipped — they aren't addressable by Pages anyway.
 */
export function FocusGutter({
  editor,
  marks,
  onChange,
}: {
  editor: Editor;
  marks: string[];
  onChange: (ids: string[]) => void;
}) {
  const drag = useRef<{ base: Set<string>; anchorIndex: number; moved: boolean } | null>(null);

  const blockEls = (): HTMLElement[] => Array.from(editor.view.dom.children) as HTMLElement[];

  const indexAtY = (clientY: number): number => {
    const els = blockEls();
    if (els.length === 0) return -1;
    for (let i = 0; i < els.length; i++) {
      const r = els[i]!.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return i;
    }
    // Above the first / below the last block → clamp to the nearest end.
    return clientY < els[0]!.getBoundingClientRect().top ? 0 : els.length - 1;
  };

  const idsInRange = (a: number, b: number): string[] => {
    const els = blockEls();
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ids: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const id = els[i]?.getAttribute('data-block-id');
      if (id) ids.push(id);
    }
    return ids;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = indexAtY(e.clientY);
    if (idx < 0) return;
    drag.current = { base: new Set(marks), anchorIndex: idx, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const idx = indexAtY(e.clientY);
    if (idx < 0) return;
    d.moved = d.moved || idx !== d.anchorIndex;
    const next = new Set(d.base);
    for (const id of idsInRange(d.anchorIndex, idx)) next.add(id);
    onChange([...next]);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // No drag → a click toggles the single anchored block.
    const id = blockEls()[d.anchorIndex]?.getAttribute('data-block-id');
    if (!id) return;
    const next = new Set(d.base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div
      className="absolute bottom-0 left-0 top-0 z-20 w-10 cursor-crosshair bg-primary/[0.04] transition-colors hover:bg-primary/10"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="presentation"
      aria-label="Focus marker — drag to mark sections for Pages, click a marked row to unmark"
      title="Drag to mark sections for Pages · click a marked row to unmark"
    />
  );
}
