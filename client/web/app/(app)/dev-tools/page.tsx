import { SetPageTitle } from '@/components/layout/page-title';
import { DevToolsClient } from './dev-tools-client';

/**
 * API Console — a built-in Postman for Mantle. Explore + run every
 * built-in REST route, every MCP tool (live from the MCP server), and
 * every agent tool; then save any HTTP request as a new agent tool.
 *
 * Data-free: DevToolsClient fetches the agent tools from GET /api/tools.
 */
export default async function DevToolsPage() {
  return (
    <>
      <SetPageTitle title="API Console" />
      <DevToolsClient />
    </>
  );
}
