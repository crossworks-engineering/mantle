'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';

/**
 * Debounced search box that writes `?q` into the URL (and clears `?page`),
 * preserving any other params. For the route-based debug list pages.
 */
export function DebugSearchBox({ placeholder }: { placeholder?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');

  useEffect(() => {
    const id = setTimeout(() => {
      const current = params.get('q') ?? '';
      if (q.trim() === current) return;
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
      next.delete('page');
      const s = next.toString();
      router.push(s ? `${pathname}?${s}` : pathname);
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder ?? 'Search…'}
        className="pl-8"
      />
    </div>
  );
}

/**
 * Prev/Next pager that writes `?page` into the URL, preserving other params.
 */
export function DebugPager({
  page,
  totalPages,
  total,
}: {
  page: number;
  totalPages: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const goto = (p: number) => {
    const next = new URLSearchParams(params.toString());
    if (p > 1) next.set('page', String(p));
    else next.delete('page');
    const s = next.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  };

  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {total} {total === 1 ? 'row' : 'rows'}
      </span>
      <div className="flex items-center gap-1.5">
        <span className="tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          size="icon"
          variant="outline"
          className="size-7"
          disabled={page <= 1}
          onClick={() => goto(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-7"
          disabled={page >= totalPages}
          onClick={() => goto(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
