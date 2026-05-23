'use client';

import { useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { pageExtensions } from '@/components/page-editor/extensions';
import { richMarkdownToHtml } from '@/lib/rich-markdown';

/**
 * Render Saskia's reply as a rich document, through the SAME TipTap schema the
 * Pages surface uses. Her markdown dialect (callouts, columns, task lists,
 * tables, highlights — see `lib/rich-markdown.ts`) is converted to HTML and fed
 * to a read-only editor, so chat output renders identically to a page and
 * picks up the shared ProseMirror CSS in globals.css.
 *
 * One editor instance per Saskia turn. Read-only, so there's no autosave or
 * input handling — it's purely a renderer that happens to be a TipTap editor
 * (which is what gets us the callout NodeView + column/table layout for free).
 */
export function RichText({ markdown }: { markdown: string }) {
  const html = useMemo(() => richMarkdownToHtml(markdown), [markdown]);

  const editor = useEditor({
    extensions: pageExtensions,
    content: html,
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm dark:prose-invert max-w-none focus:outline-none [&>:first-child]:mt-0 [&>:last-child]:mb-0',
      },
    },
  });

  // Re-apply when the text changes (e.g. an optimistic row resolves to the
  // server copy). Cheap — Saskia turns are immutable once persisted.
  useEffect(() => {
    if (editor) editor.commands.setContent(html);
  }, [editor, html]);

  if (!editor) {
    // SSR / first paint before the client editor mounts: render nothing
    // (immediatelyRender:false means the editor is client-only).
    return null;
  }
  return <EditorContent editor={editor} />;
}
