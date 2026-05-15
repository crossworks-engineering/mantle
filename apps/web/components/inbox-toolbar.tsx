'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpDown } from 'lucide-react';
import { DEFAULT_SORT, SORT_OPTIONS, type SortKey } from './inbox-sort';

/**
 * Sort selector + result count for the inbox list. Pure UI; the sort
 * constants and parser live in `./inbox-sort.ts` so the server page can
 * import them without bumping into the `'use client'` boundary.
 *
 * The current value is read from `?sort=` on the URL so the choice is
 * shareable and survives back/forward navigation.
 */
export function InboxToolbar({ sort, count }: { sort: SortKey; count: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function onChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_SORT) params.delete('sort');
    else params.set('sort', next);
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  }

  return (
    <header className="flex h-10 items-center justify-between border-b border-border bg-muted/30 px-3 text-xs">
      <span className="text-muted-foreground">
        <span className={pending ? 'opacity-50' : ''}>{count}</span>{' '}
        {count === 1 ? 'email' : 'emails'}
      </span>
      <label className="inline-flex items-center gap-1.5">
        <ArrowUpDown className="size-3 text-muted-foreground" aria-hidden />
        <select
          value={sort}
          onChange={(e) => onChange(e.target.value)}
          className="bg-transparent text-xs focus:outline-none"
          disabled={pending}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </header>
  );
}
