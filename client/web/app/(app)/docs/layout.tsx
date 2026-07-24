'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { SetPageTitle } from '@/components/layout/page-title';
import { DocsNav } from './docs-nav';
import type { ReaderNav } from '@/lib/docs-types';

/**
 * Shared frame for the docs reader: master-detail grid, navigation left,
 * selected doc right. Client-fetch (GET /api/docs/reader) — the markdown
 * lives on the SERVER's disk; this app is zero-secret and diskless.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const navQuery = useQuery({
    queryKey: ['docs-reader-nav'],
    queryFn: () => apiFetch<{ nav: ReaderNav }>('/api/docs/reader'),
  });

  return (
    <>
      <SetPageTitle title="Docs" />
      <div className="md:grid md:h-full md:grid-cols-[300px_1fr] md:overflow-hidden">
        <div className="flex flex-col border-b md:h-full md:min-h-0 md:border-b-0 md:border-r">
          {navQuery.data ? (
            <DocsNav nav={navQuery.data.nav} />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              {navQuery.isError ? 'Could not load the docs list.' : 'Loading docs…'}
            </p>
          )}
        </div>
        <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">{children}</div>
      </div>
    </>
  );
}
