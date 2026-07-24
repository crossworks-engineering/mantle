'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { Button } from '@mantle/web-ui/ui/button';
import { DevToolsShell } from '@/components/dev-tools/dev-tools-shell';
import type { AgentToolInfo } from '@/lib/dev-tools/types';

/**
 * Data-free wrapper for the API Console. Fetches the owner's agent tools from
 * GET /api/tools to seed DevToolsShell (the rest of the console's state is
 * client-managed). The console's per-request execution still goes through the
 * /api/dev-tools/* routes inside the provider.
 */
export function DevToolsClient() {
  // Unwrap to the array — the ['tools'] cache is shared with settings/tools and
  // settings/tool-groups, which both store `r.tools` (the array). Returning the
  // wrapper object here would mean whichever screen filled the cache first wins,
  // and the other reads the wrong shape (the bug that crashed this console).
  const toolsQuery = useQuery({
    queryKey: ['tools'],
    queryFn: () => apiFetch<{ tools: AgentToolInfo[] }>('/api/tools').then((r) => r.tools),
  });

  if (toolsQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (toolsQuery.isError && !toolsQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Couldn&apos;t load the API console.</p>
        <Button variant="outline" size="sm" onClick={() => toolsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return <DevToolsShell initialAgentTools={toolsQuery.data} />;
}
