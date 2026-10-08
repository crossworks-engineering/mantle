/**
 * GET /api/member/mcp: a member's own view of Settings > MCP (team apps
 * Phase 1, plan page b6dd688e). What it answers:
 *
 *  - `remoteEnabled`: the box-level remote MCP switch (an admin's);
 *  - `connectorUrl`: the URL to paste into an MCP client;
 *  - `access`: the member's own MCP and Write switches, read only (an admin
 *    sets them in Settings > MCP > Team and client access);
 *  - `clients`: the MCP clients THIS member connected (their live OAuth
 *    grants), never another login's;
 *  - `connectors`: the connectors open at team level (team apps Phase 2),
 *    each with its read and write tool counts.
 *
 * A member only: an admin uses Settings > MCP itself, a client has no MCP
 * screen yet. Nothing here is writable but the member's own disconnect
 * (./clients/[id]/route.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { and, eq } from 'drizzle-orm';
import { agents, db, mcpLoginAccess } from '@mantle/db';
import { TEAM_RESPONDER_SLUG } from '@mantle/runtime/assistant';
import { loadProfilePreferences } from '@mantle/content';
import { listLoginConnectorTools } from '@mantle/tools';
import type { MemberMcpConnector, MemberMcpView } from '@mantle/client-types';
import { getMemberOr401 } from '@/lib/auth';
import { connectorUrl } from '@/lib/mcp-oauth';
import { listLoginClients } from '@/lib/mcp-clients';

export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const [prefs, [access], clients, tools] = await Promise.all([
    loadProfilePreferences(member.anchorId),
    db
      .select({ enabled: mcpLoginAccess.enabled, writeEnabled: mcpLoginAccess.writeEnabled })
      .from(mcpLoginAccess)
      .where(eq(mcpLoginAccess.loginId, member.loginId))
      .limit(1),
    listLoginClients(member.anchorId, member.loginId),
    listLoginConnectorTools(member.anchorId, 'team'),
  ]);
  // The connectors open at team level (team apps Phase 2), by connector:
  // none while MCP is closed to the member (the box or their own switch) or
  // the team surface is closed (its responder not at team level), as their
  // MCP then lists no connector tool either (M2 audit, low 7).
  const [responder] = await db
    .select({ audience: agents.audience, enabled: agents.enabled })
    .from(agents)
    .where(and(eq(agents.ownerId, member.anchorId), eq(agents.slug, TEAM_RESPONDER_SLUG)))
    .limit(1);
  const open =
    prefs.remoteMcpEnabled === true &&
    access?.enabled === true &&
    responder?.enabled === true &&
    responder.audience === 'team';
  const byGroup = new Map<string, MemberMcpConnector>();
  for (const t of open ? tools : []) {
    const c = byGroup.get(t.groupId) ?? {
      id: t.groupId,
      name: t.groupName,
      level: t.groupLevel,
      readTools: 0,
      writeTools: 0,
    };
    if (t.readOnly) c.readTools += 1;
    else c.writeTools += 1;
    byGroup.set(t.groupId, c);
  }
  const body: MemberMcpView = {
    remoteEnabled: prefs.remoteMcpEnabled === true,
    connectorUrl: connectorUrl(),
    access: { enabled: access?.enabled === true, writeEnabled: access?.writeEnabled === true },
    clients,
    connectors: [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
