'use client';

import Link from 'next/link';
import { FileText, Link2, StickyNote, type LucideIcon } from 'lucide-react';
import type { Backlink } from '@server/lib/pages';
import { nodeHref } from '@/lib/node-href';

const TYPE_ICON: Record<string, LucideIcon> = {
  page: FileText,
  note: StickyNote,
};

/**
 * "Referenced by" — the pages/notes that link to this page (inbound `references`
 * edges, written by the extractor on commit). Renders nothing when empty so a
 * page with no backlinks stays clean. A read-only graph view: the edges are
 * authored elsewhere; here we only surface + navigate them.
 */
export function PageBacklinks({ backlinks }: { backlinks: Backlink[] }) {
  if (backlinks.length === 0) return null;

  return (
    <section className="mt-12 border-t border-border pt-6">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden />
        Referenced by
        <span className="font-normal normal-case tracking-normal">({backlinks.length})</span>
      </h2>
      <ul className="flex flex-col gap-1">
        {backlinks.map((b) => {
          const href = nodeHref(b.type, b.id);
          const Icon = TYPE_ICON[b.type] ?? FileText;
          const inner = (
            <>
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                {b.icon ? (
                  <span aria-hidden>{b.icon}</span>
                ) : (
                  <Icon className="size-4" aria-hidden />
                )}
              </span>
              <span className="min-w-0 truncate text-sm">{b.title || 'Untitled'}</span>
            </>
          );
          return (
            <li key={b.id}>
              {href ? (
                <Link
                  href={href}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {inner}
                </Link>
              ) : (
                <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground">
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
