import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { McpSettingsClient } from './mcp-client';

/**
 * /settings/mcp — the remote MCP connector. Data-free: McpSettingsClient fetches
 * GET /api/mcp-settings (enabled flag, connector URL, connected clients), toggles
 * via PATCH, disconnects via DELETE /api/mcp-clients/[id], and health-checks via
 * POST /api/mcp-status.
 */
export default async function McpSettingsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="MCP connector" />
      <McpSettingsClient />
    </>
  );
}
