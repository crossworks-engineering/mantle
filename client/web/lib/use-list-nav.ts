'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

/**
 * URL-driven list navigation for SSR search + pagination (the /pages pattern,
 * shared by /tasks, /events, /secrets). `go(patch)` merges a patch into the
 * current query string — `null`/`''` deletes a key — and pushes, so the server
 * page re-renders with the new filters/page. `pending` drives a busy state.
 */
export function useListNav() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();

  const go = (patch: Record<string, string | number | null | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') params.delete(k);
      else params.set(k, String(v));
    }
    const s = params.toString();
    start(() => router.push(s ? `${pathname}?${s}` : pathname));
  };

  return { pending, go };
}
