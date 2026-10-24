/**
 * GET /api/member/mcp: a member's own view of Settings > MCP (team apps
 * Phase 1, plan page b6dd688e). What it answers:
 *
 *  - `remoteEnabled`: the box-level remote MCP switch (an admin's);
 *  - `connectorUrl`: the URL to paste into an MCP client;
 *  - `access`: always on since workspaces W7b (the per-login MCP and Write
 *    switches went: a login reaches MCP in its own workspaces, and writes
 *    where its workspaces let it);
 *  - `clients`: the MCP clients THIS member connected (their live OAuth
 *    grants), never another login's;
 *  - `connectors`: the connectors the member's own MCP really offers (team
 *    apps Phase 2; access matrix N10): the connector tools of the member's
 *    workspaces, as the one MCP surface lists them for an OAuth client of
 *    this member (W7b). Each with its read and write tool counts.
 *
 * A member only: an admin uses Settings > MCP itself, a client has no MCP
 * screen yet. Nothing here is writable but the member's own disconnect
 * (./clients/[id]/route.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { loadProfilePreferences } from '@mantle/content';
import { listLoginConnectorTools } from '@mantle/tools';
import type { MemberMcpConnector, MemberMcpView } from '@mantle/client-types';
import { memberCaller } from '@/lib/auth';
import { connectorUrl } from '@/lib/mcp-oauth';
import { listLoginClients } from '@/lib/mcp-clients';
import { feature } from '@mantle/config';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'member' },
});

export async function GET() {
  const member = memberCaller();
  const [prefs, clients, tools] = await Promise.all([
    loadProfilePreferences(member.anchorId),
    listLoginClients(member.anchorId, member.loginId),
    listLoginConnectorTools(member.anchorId, member.loginId),
  ]);
  // The connectors the member's MCP offers (M2 audit, low 7; access matrix
  // N10): none while the box's remote MCP is off; else the connector tools
  // of the member's workspaces, as the one surface lists them (W7b).
  const open = feature('remoteMcp', { prefs });
  const offered = new Set(open ? tools.map((t) => t.tool.id) : []);
  const byGroup = new Map<string, MemberMcpConnector>();
  for (const t of tools) {
    if (!offered.has(t.tool.id)) continue;
    const c = byGroup.get(t.groupId) ?? {
      id: t.groupId,
      name: t.groupName,
      readTools: 0,
      writeTools: 0,
    };
    if (t.readOnly) c.readTools += 1;
    else c.writeTools += 1;
    byGroup.set(t.groupId, c);
  }
  const body: MemberMcpView = {
    remoteEnabled: feature('remoteMcp', { prefs }),
    connectorUrl: connectorUrl(),
    access: { enabled: true, writeEnabled: true },
    clients,
    connectors: [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': CACHE_CONTROL.none } });
}
