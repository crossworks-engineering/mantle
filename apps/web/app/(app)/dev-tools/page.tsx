import { requireOwner } from '@/lib/auth';
import { listToolsForOwner } from '@/lib/tools';
import { SetPageTitle } from '@/components/layout/page-title';
import { DevToolsShell } from '@/components/dev-tools/dev-tools-shell';
import type { AgentToolInfo } from '@/lib/dev-tools/types';

/**
 * API Console — a built-in Postman for Mantle. Explore + run every
 * built-in REST route, every MCP tool (live from the MCP server), and
 * every agent tool; then save any HTTP request as a new agent tool.
 */
export default async function DevToolsPage() {
  const user = await requireOwner();
  const tools = await listToolsForOwner(user.id);

  return (
    <>
      <SetPageTitle title="API Console" />
      <DevToolsShell initialAgentTools={tools as AgentToolInfo[]} />
    </>
  );
}
