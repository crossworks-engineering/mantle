'use client';

import { useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { Copy, Ellipsis, GripVertical, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Block gutter handle: a drag grip plus an actions menu (Duplicate / Delete).
 *
 * The grip and the menu trigger are SEPARATE elements, on purpose:
 *  - The grip is a plain element, so the native dragstart fires (wrapping the
 *    drag target in a Radix trigger preventDefaults pointerdown and kills the
 *    drag — that was the earlier "grab cursor but no movement" bug).
 *  - The menu lives on its own ⋮ button. Radix suppressing drag-from-the-button
 *    is exactly what we want there, and the menu Content is portaled out, so it
 *    doesn't interfere with the draggable container.
 *
 * Actions target the block the handle is currently over (its top-level node),
 * so this is how you delete a column row, a callout, etc.
 */
export function EditorDragHandle({ editor }: { editor: Editor }) {
  const posRef = useRef<number | null>(null);

  const remove = () => {
    const pos = posRef.current;
    if (pos == null || pos < 0) return;
    editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
  };

  const duplicate = () => {
    const pos = posRef.current;
    if (pos == null || pos < 0) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run();
  };

  return (
    <DragHandle
      editor={editor}
      onNodeChange={({ node, pos }) => {
        posRef.current = node ? pos : null;
      }}
    >
      <div className="mr-2 flex items-center gap-0.5">
        <div
          role="button"
          aria-label="Drag to move"
          className="flex h-7 w-5 cursor-grab items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-5" aria-hidden />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Block actions"
              className="flex h-7 w-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" className="w-44">
            <DropdownMenuItem onSelect={duplicate}>
              <Copy /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={remove}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </DragHandle>
  );
}
