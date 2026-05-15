'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';

/**
 * Live, debounced search. Updates `?q=` in the URL ~200ms after the user
 * stops typing — Server Component re-renders with fresh `email_senders`
 * rows. Clearing the field removes `q` entirely (rather than leaving an
 * empty `q=`), so the list resets to "everything in this tab".
 *
 * State is intentionally local to this component, not derived from the URL
 * on every render — that means typing isn't disrupted by the parallel RSC
 * navigation that the debounced URL update triggers.
 */
export function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  // Track whether the user has touched the input so the very first render
  // doesn't fire a navigation back to the same URL.
  const hasInteractedRef = useRef(false);

  useEffect(() => {
    if (!hasInteractedRef.current) return;
    const handle = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = value.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      });
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function onChange(next: string) {
    hasInteractedRef.current = true;
    setValue(next);
  }

  return (
    <div className="relative ml-auto">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search address or domain…"
        className="h-8 w-64 rounded-md border border-input bg-background pl-8 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {value && !pending && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
      {pending && (
        <Loader2
          className="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-hidden
        />
      )}
    </div>
  );
}
