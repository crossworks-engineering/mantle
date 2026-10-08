/**
 * A member's own view of Settings > MCP (team apps Phase 1): GET
 * /api/member/mcp. The member reads their access here; an admin sets it.
 * The only thing a member changes is their own connected clients
 * (DELETE /api/member/mcp/clients/:id).
 */

/** One MCP client the member connected: their live OAuth grants on it. */
export type MemberMcpClient = {
  id: string;
  /** The name the client registered with (e.g. "Claude"); null if none. */
  clientName: string | null;
  /** ISO: the earliest of this member's live grants on it. */
  connectedAt: string;
  /** ISO: the last call, null when never used. */
  lastUsedAt: string | null;
  activeTokens: number;
};

export type MemberMcpView = {
  /** The box-level remote MCP switch (an admin's). Off, no MCP works. */
  remoteEnabled: boolean;
  /** The URL to paste into an MCP client. */
  connectorUrl: string;
  /** The member's own switches, set by an admin: MCP at all, and Write
   *  (drafts in their own space, and rows of apps opened to MCP). */
  access: { enabled: boolean; writeEnabled: boolean };
  /** The clients this member connected, never another login's. */
  clients: MemberMcpClient[];
  /** The connectors (outside data sources) open at the member's level (team
   *  apps Phase 2): their MCP and their apps may use these tools. Read
   *  tools carry the admin's read-only mark; write tools need Write on
   *  over MCP. Absent from a brain before Phase 2. */
  connectors?: MemberMcpConnector[];
};

/** One connector open to the member. */
export type MemberMcpConnector = {
  id: string;
  name: string;
  /** The connector's level: team, client or public. */
  level: string;
  readTools: number;
  writeTools: number;
};
