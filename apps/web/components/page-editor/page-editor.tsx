'use client';

import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import { cn } from '@/lib/utils';
import { pageExtensions } from './extensions';
import { EditorToolbar } from './toolbar';

/**
 * The live, editable TipTap surface for a page. `content` is the initial
 * ProseMirror doc (the editor owns its state thereafter); `onChange` fires on
 * every edit with the current JSON. We keep `onChange` in a ref so the
 * editor's `onUpdate` closure always calls the latest handler — otherwise a
 * debounced autosave that re-creates its callback would go stale.
 */
export function PageEditor({
  content,
  onChange,
  onBlur,
  className,
}: {
  content: JSONContent;
  onChange: (doc: JSONContent) => void;
  /** Fires when the editor loses focus — a natural "settle" signal the
   *  caller can use to flush / re-index. */
  onBlur?: () => void;
  className?: string;
}) {
  // Keep callbacks in refs so the editor's once-bound handlers always call the
  // latest closures (a debounced autosave re-creates them every render).
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
  }, [onChange, onBlur]);

  const editor = useEditor({
    extensions: pageExtensions,
    content,
    immediatelyRender: false, // required for Next.js SSR (avoids hydration mismatch)
    editorProps: {
      attributes: {
        class:
          'prose prose-sm dark:prose-invert max-w-none min-h-[60vh] px-4 py-3 focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getJSON()),
    onBlur: () => onBlurRef.current?.(),
  });

  if (!editor) return null;

  return (
    <div className={cn('rounded-md border border-border bg-card', className)}>
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
