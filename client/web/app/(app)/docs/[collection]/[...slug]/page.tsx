'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@mantle/web-ui/api-fetch';
import { DocView } from '../../doc-view';
import type { ReaderDoc } from '@/lib/docs-types';

/**
 * One documentation page, read from the SERVER's disk via
 * GET /api/docs/reader/doc. The route's 404 covers unknown collections and
 * the traversal/extension guard (the authoritative check stays server-side).
 */
export default function DocPage({
  params,
}: {
  params: Promise<{ collection: string; slug: string[] }>;
}) {
  const { collection, slug } = use(params);
  const relPath = slug.map((s) => decodeURIComponent(s)).join('/');
  const col = decodeURIComponent(collection);

  const docQuery = useQuery({
    queryKey: ['docs-reader-doc', col, relPath],
    queryFn: () =>
      apiFetch<{ doc: ReaderDoc }>(
        `/api/docs/reader/doc?collection=${encodeURIComponent(col)}&path=${encodeURIComponent(relPath)}`,
      ),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  if (docQuery.isError) {
    const notFound = docQuery.error instanceof ApiError && docQuery.error.status === 404;
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {notFound ? 'This doc does not exist.' : 'Could not load this doc.'}
      </p>
    );
  }
  if (!docQuery.data) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  return <DocView doc={docQuery.data.doc} />;
}
