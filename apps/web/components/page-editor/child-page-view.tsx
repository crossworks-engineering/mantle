'use client';

import { useEffect, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import Link from 'next/link';
import { ChevronRight, FileText } from 'lucide-react';
import { apiFetch } from '@mantle/web-ui/api-fetch';

/**
 * Card chrome for a `childPage` block — a clickable link to a sub-page. The
 * node is an atom (read-only content), so the whole card is a Next `Link` that
 * navigates client-side to the child. Themed via tokens so it tracks the active
 * theme like the rest of the document.
 *
 * The `title` / `icon` attrs are a snapshot taken when the card was inserted;
 * we refresh them from `/api/pages/<id>` on mount so a later rename of the
 * child shows up here without re-authoring the card.
 */
export function ChildPageView({ node }: NodeViewProps) {
  const pageId = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : null;
  const snapTitle =
    typeof node.attrs.title === 'string' && node.attrs.title ? node.attrs.title : 'Untitled page';
  const snapIcon = typeof node.attrs.icon === 'string' ? node.attrs.icon : null;

  const [title, setTitle] = useState(snapTitle);
  const [icon, setIcon] = useState<string | null>(snapIcon);

  // Refresh the live title/icon so renames of the child reflect here. Display
  // only — we don't write back into the node attrs (that would churn the
  // autosave every time the parent opens).
  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    apiFetch<{ page?: { title?: string; icon?: string | null } }>(`/api/pages/${pageId}`)
      .then((data) => {
        if (cancelled || !data?.page) return;
        if (typeof data.page.title === 'string' && data.page.title) setTitle(data.page.title);
        setIcon(typeof data.page.icon === 'string' ? data.page.icon : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  return (
    <NodeViewWrapper className="my-2" data-drag-handle>
      <Link
        href={pageId ? `/pages/${pageId}` : '#'}
        contentEditable={false}
        className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 no-underline transition-colors hover:bg-accent/40"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-base leading-none">
          {icon ?? <FileText className="size-4 text-muted-foreground" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
    </NodeViewWrapper>
  );
}
