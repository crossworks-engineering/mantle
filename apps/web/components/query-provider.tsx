'use client';

/**
 * TanStack Query provider — the client data layer for the frontend/backend
 * split (Phase 2 · Task 4). Screens converted off SSR fetch their data with
 * `useQuery` against `/api/**` and invalidate via the query client (replacing
 * the server's `revalidatePath`). One client per browser tab, kept in state so
 * Fast Refresh / re-renders don't mint a new cache.
 *
 * Conventions (see docs/client-data-fetching.md):
 *  - Query keys are arrays mirroring the URL: ['skills'], ['skills', id].
 *  - Mutations call the matching endpoint, then invalidate the affected keys.
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Single-tenant, mostly-fresh data: don't refetch on every focus,
            // but treat data as stale after 30s so navigation re-validates.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
