'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, FileText, ListTree } from 'lucide-react';
import { cn } from './lib/utils';
import type { TocEntry } from '@mantle/content/page-toc';

const COLLAPSE_KEY = 'mantle:page-outline-collapsed';

/**
 * Floating outline / table-of-contents for a page: headings (h1–h3, indented by
 * level) and sub-page cards (indented under their section). Used on all three
 * surfaces — editor, in-app read-only view, and the public share page.
 *
 * Collapsible: a header toggle hides the list down to a small handle; the
 * choice persists in localStorage so it sticks across pages + reloads.
 *
 * Jumping: pass `onJump` to scroll via the editor API (the editor surface);
 * omit it and the outline scrolls the DOM element whose `id` matches the block
 * id (the rendered/public surfaces, where headings carry `id={blockId}`). The
 * parent owns the floating placement (a sticky left rail); this is just the
 * list.
 */
export function PageOutline({
  entries,
  onJump,
  className,
}: {
  entries: TocEntry[];
  onJump?: (id: string) => void;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Restore the collapse preference on mount (avoids an SSR/first-paint flip).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // ignore unavailable storage
    }
  }, []);

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });

  if (entries.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Show outline"
        title="Show outline"
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
          className,
        )}
      >
        <ListTree className="size-4" aria-hidden />
      </button>
    );
  }

  const jump = (id: string) => {
    if (onJump) {
      onJump(id);
      return;
    }
    if (typeof document !== 'undefined') {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <nav className={cn('text-sm', className)} aria-label="Page outline">
      <div className="mb-2 flex items-center justify-between gap-2 px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          On this page
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-label="Hide outline"
          title="Hide outline"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
      </div>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => jump(e.id)}
              style={{ paddingLeft: 8 + e.depth * 12 }}
              title={e.label}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left leading-snug transition-colors hover:bg-accent hover:text-accent-foreground',
                e.kind === 'page'
                  ? 'text-muted-foreground'
                  : e.level === 1
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {e.kind === 'page' && (
                <FileText className="size-3.5 shrink-0 opacity-70" aria-hidden />
              )}
              <span className="truncate">{e.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
