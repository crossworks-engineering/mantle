'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@mantle/web-ui/layout/back-link';
import type { TraceDetail as TraceDetailRow } from '@mantle/web-ui/traces-format';
import { TraceDetailView } from '../trace-detail-view';

/**
 * Data-free /traces/[id] deep link: fetches the trace from GET /api/traces/[id]
 * and reuses the shared TraceDetailView, setting the page title once loaded.
 */
export function TracePageClient({ id }: { id: string }) {
  const traceQuery = useQuery({
    queryKey: ['traces', id],
    queryFn: () => apiFetch<{ trace: TraceDetailRow }>(`/api/traces/${id}`),
    retry: false,
  });

  if (traceQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (traceQuery.isError) {
    const notFound = traceQuery.error instanceof ApiError && traceQuery.error.status === 404;
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {notFound ? 'That trace no longer exists.' : "Couldn't load this trace."}
      </div>
    );
  }

  const trace = traceQuery.data.trace;
  return (
    <>
      <SetPageTitle title={trace.kind} />
      <BackLink href="/traces">Traces</BackLink>
      <TraceDetailView trace={trace} />
    </>
  );
}
