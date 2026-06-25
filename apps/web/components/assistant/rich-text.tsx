'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
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
  const router = useRouter();
  const html = useMemo(() => richMarkdownToHtml(markdown), [markdown]);

  // The shared page extensions set `link.openOnClick:false` (right for the
  // editable canvas, where a click places the cursor). Here the reply is
  // read-only, so links should actually navigate — including the `/n/<id>`
  // permalinks responders embed to point at a document. Same-origin links go
  // through the SPA router (no full reload); external links open in a new tab.
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const anchor = (e.target as HTMLElement).closest('a');
      const href = anchor?.getAttribute('href');
      if (!href) return;
      const url = new URL(href, window.location.origin);
      if (url.origin === window.location.origin) {
        e.preventDefault();
        router.push(url.pathname + url.search + url.hash);
      } else {
        e.preventDefault();
        window.open(url.href, '_blank', 'noopener,noreferrer');
      }
    },
    [router],
  );

  const editor = useEditor({
    extensions: pageExtensions,
    content: html,
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // Base `prose` (16px reading size) — Saskia's reply is the document, so
        // it reads at full size like a page (not the smaller prose-sm).
        class:
          'prose dark:prose-invert max-w-none focus:outline-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_pre]:leading-relaxed',
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
  return (
    <div onClick={onClick}>
      <EditorContent editor={editor} />
    </div>
  );
}
