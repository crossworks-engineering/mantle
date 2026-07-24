'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { NodeBiography } from '@/components/node-biography';
import type { NodeBiographyView } from '@/lib/node-biography';

/**
 * Data-free node biography. Fetches the fully-resolved view from
 * GET /api/nodes/[id]/history and renders the (presentational) NodeBiography.
 */
export function NodeHistoryClient({ id }: { id: string }) {
  const historyQuery = useQuery({
    queryKey: ['nodes', id, 'history'],
    queryFn: () => apiFetch<{ view: NodeBiographyView }>(`/api/nodes/${id}/history`),
    retry: false,
  });

  if (historyQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (historyQuery.isError) {
    const notFound = historyQuery.error instanceof ApiError && historyQuery.error.status === 404;
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {notFound ? 'That node no longer exists.' : "Couldn't load this node's history."}
      </div>
    );
  }

  return <NodeBiography view={historyQuery.data.view} />;
}
