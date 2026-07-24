'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';

/**
 * Compact footer pager for the master-detail list panes (the /pages pattern).
 * Shown whenever there are items — it doubles as a "N total" count, with the
 * arrows disabled at the bounds — and only hides when the list is empty.
 * `onGo` receives the target page number; the caller pushes it via `useListNav`.
 */
export function ListPager({
  page,
  total,
  pageSize,
  pending = false,
  onGo,
}: {
  page: number;
  total: number;
  pageSize: number;
  pending?: boolean;
  onGo: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        {total} total · page {page} / {totalPages}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1 || pending}
          onClick={() => onGo(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page >= totalPages || pending}
          onClick={() => onGo(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
