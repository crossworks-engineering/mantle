'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { DevToolsShell } from '@/components/dev-tools/dev-tools-shell';
import type { AgentToolInfo } from '@/lib/dev-tools/types';

/**
 * Data-free wrapper for the API Console. Fetches the owner's agent tools from
 * GET /api/tools to seed DevToolsShell (the rest of the console's state is
 * client-managed). The console's per-request execution still goes through the
 * /api/dev-tools/* routes inside the provider.
 */
export function DevToolsClient() {
  const toolsQuery = useQuery({
    queryKey: ['tools'],
    queryFn: () => apiFetch<{ tools: AgentToolInfo[] }>('/api/tools'),
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

  return <DevToolsShell initialAgentTools={toolsQuery.data.tools} />;
}
