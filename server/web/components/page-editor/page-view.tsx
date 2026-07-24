'use client';

import { useEffect } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import { pageExtensions } from './extensions';

/**
 * Read-only render of a page document, using the same extension set as the
 * editor so output matches exactly. Content is re-applied when it changes so
 * the list preview pane updates as you select different pages.
 *
 * (Phase 5's public renderer will swap this for a server-side
 * JSON→sanitized-HTML pass; a live read-only editor is fine inside the
 * authenticated app.)
 */
export function PageView({ content }: { content: JSONContent }) {
  const editor = useEditor({
    extensions: pageExtensions,
    content,
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'prose dark:prose-invert prose-accent max-w-none focus:outline-none' },
    },
  });

  useEffect(() => {
    if (editor && content) editor.commands.setContent(content);
  }, [editor, content]);

  if (!editor) return null;
  return <EditorContent editor={editor} />;
}
