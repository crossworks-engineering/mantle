'use client';

import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TocEntry } from '@mantle/content/page-toc';

/**
 * Floating outline / table-of-contents for a page: headings (h1–h3, indented by
 * level) and sub-page cards (indented under their section). Used on all three
 * surfaces — editor, in-app read-only view, and the public share page.
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
  if (entries.length === 0) return null;

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
      <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => jump(e.id)}
              style={{ paddingLeft: 8 + e.depth * 12 }}
              title={e.label}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left leading-snug transition-colors hover:bg-accent hover:text-foreground',
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
