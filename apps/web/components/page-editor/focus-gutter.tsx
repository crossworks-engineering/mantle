'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { cn } from '@/lib/utils';

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
 * Block resolution: the index under the pointer comes from hit-testing the
 * editable's direct children by vertical rect (x/scroll-independent); the id
 * comes from the DOC MODEL (`doc.child(index).attrs.id`), because NodeView
 * blocks (callout, image, fileEmbed, childPage) render a React wrapper that
 * doesn't emit `data-block-id`. Id-less (just-typed, unsaved) blocks are
 * skipped — they aren't addressable by Pages anyway.
 *
 * Affordance: a rounded, inset background pill (padded off the text) plus a
 * small dot centered on every markable block — faint normally, filled in the
 * primary colour when that block is marked.
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [dots, setDots] = useState<{ top: number; id: string }[]>([]);

  const blockEls = (): HTMLElement[] => Array.from(editor.view.dom.children) as HTMLElement[];

  const indexAtY = (clientY: number): number => {
    const els = blockEls();
    if (els.length === 0) return -1;
    // If the pointer is inside a block's rect, that's the block. Otherwise pick
    // the vertically-NEAREST block: a pointer in the gap/margin around a thin
    // element (e.g. a divider / "page break") then maps to that adjacent block
    // instead of clamping to the last one — which used to mark the whole doc.
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < els.length; i++) {
      const r = els[i]!.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return i;
      const dist = clientY < r.top ? r.top - clientY : clientY - r.bottom;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  };

  // Resolve a top-level block's id from the DOC MODEL, not the DOM. NodeView
  // blocks (callout, image, fileEmbed, childPage) render a React wrapper that
  // doesn't emit the global `data-block-id` attribute, so reading the DOM
  // misses them — but `attrs.id` is always on the PM node. The editable's
  // direct children line up 1:1 with the doc's top-level nodes by index, so
  // the rect-based index maps straight to `doc.child(index)`.
  const idAtIndex = (i: number): string | null => {
    const node = editor.state.doc.maybeChild(i);
    const id = node?.attrs?.id;
    return typeof id === 'string' && id ? id : null;
  };

  const idsInRange = (a: number, b: number): string[] => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ids: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const id = idAtIndex(i);
      if (id) ids.push(id);
    }
    return ids;
  };

  // Place a dot at each markable block's vertical centre, in gutter-local
  // coordinates. Re-measured on doc changes / scroll / resize (rAF-throttled).
  const measure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const gTop = c.getBoundingClientRect().top;
    const els = Array.from(editor.view.dom.children) as HTMLElement[];
    const next: { top: number; id: string }[] = [];
    for (let i = 0; i < els.length; i++) {
      const node = editor.state.doc.maybeChild(i);
      const id = node?.attrs?.id;
      if (typeof id !== 'string' || !id) continue;
      const r = els[i]!.getBoundingClientRect();
      next.push({ top: r.top - gTop + r.height / 2, id });
    }
    setDots(next);
  }, [editor]);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    schedule();
    editor.on('update', schedule);
    window.addEventListener('resize', schedule);
    // Capture so it fires for the editor's own scroll container, not just window.
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      editor.off('update', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [editor, measure]);

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
    const id = idAtIndex(d.anchorIndex);
    if (!id) return;
    const next = new Set(d.base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  const markedSet = new Set(marks);

  return (
    <div
      ref={containerRef}
      className="group absolute bottom-0 left-0 top-0 z-20 w-10 cursor-ns-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="presentation"
      aria-label="Focus marker — drag to mark sections for Pages, click a marked row to unmark"
      title="Drag to mark sections for Pages · click a marked row to unmark"
    >
      {/* Rounded, inset background — padded off the text, theme-radius corners. */}
      <div
        className="pointer-events-none absolute bottom-1 left-1.5 right-3 top-1 bg-primary/[0.05] transition-colors group-hover:bg-primary/10"
        style={{ borderRadius: 'var(--radius)' }}
      />
      {/* A dot per markable block — faint normally, filled primary when marked. */}
      {dots.map((d) => (
        <span
          key={d.id}
          className={cn(
            'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-all',
            markedSet.has(d.id) ? 'size-2 bg-primary' : 'size-[5px] bg-foreground/20',
          )}
          style={{ top: `${d.top}px`, left: '17px' }}
        />
      ))}
    </div>
  );
}
