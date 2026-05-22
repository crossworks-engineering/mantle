'use client';

import type { Editor } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { GripVertical } from 'lucide-react';

/**
 * Notion-style block handle in the left gutter: drag it to reorder the block.
 *
 * The handle's child MUST be a plain, non-interactive element. Wrapping it in
 * a Radix menu trigger / <button> attaches pointer handlers that call
 * preventDefault and swallow the native dragstart — the symptom is a grab
 * cursor that won't actually move the block. Block actions (duplicate/delete)
 * will return later via a non-conflicting affordance.
 *
 * Docs: https://tiptap.dev/docs/editor/extensions/functionality/drag-handle-react
 */
export function EditorDragHandle({ editor }: { editor: Editor }) {
  return (
    <DragHandle editor={editor}>
      <div
        role="button"
        aria-label="Drag to move"
        className="mr-2 flex h-7 w-6 cursor-grab items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-5" aria-hidden />
      </div>
    </DragHandle>
  );
}
