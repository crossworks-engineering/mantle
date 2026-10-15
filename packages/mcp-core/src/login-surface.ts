/**
 * MCP as a login (plan page e5b854dd, 2026-10-03), one surface for every
 * login since workspaces W7b (plan 7.4).
 *
 * `/api/mcp` serves any LOGIN the same owner surface (build-server.ts), each
 * tool listed and called through the one gate (gated-tools.ts, arch A5
 * step 4) as the connection's caller (gate-policy.ts mcpGateCaller): each
 * call in that login's own scope (mcp-scope.ts: the union of its
 * workspaces, Moderator where it is one):
 *
 *  - LISTED by the scope: an adminOnly (or an ownerOnly one whose policy
 *    is adminOnly) tool only where the scope holds the Admin
 *    workspace, an Admin-area tool only where that area is on (the gate's
 *    Admin step);
 *  - an API key or a peer is narrowed further by its write switch and the
 *    risky-tool rule (the gate's narrowers, from the policy), a key by its areas too (plan 7.5 and 7.6: a key or a
 *    peer acts as its login and only narrows it). The login's own OAuth
 *    consent is not;
 *  - a create takes an optional `workspace` and names where it landed
 *    (create-home.ts; the gate's step 6 names the home).
 *
 * The member and client tool sets, the per-login MCP switch and the
 * my_app_* tools went (W7b), the client login and the static login tokens
 * in W8a: a login carries no permission of its own.
 *
 * `McpCaller` is the one context every MCP auth path resolves to, so a tool
 * that must act for the calling login reads it from the surface the call
 * runs on, never from model arguments.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import {
  SCOPE_AREAS,
  asSystem,
  auditLog,
  brainOnWorkspacesNow,
  db,
  createHomeIntent,
  gateLists,
  loginScopeFor,
  scopeHasArea,
  scopeHoldsAdmin,
  withTurnScope,
  type PolicyRef,
  type ScopeArea,
  type Tool,
  type WorkspaceScope,
  markCallAudited,
} from '@mantle/db';
import {
  connectorMarkRefusal,
  connectorToolPolicy,
  listLoginConnectorTools,
  loginConnectorRefused,
  mcpBuiltinToolRef,
  type AdminGateView,
  type LoginMcpChannel,
  type ToolSurface,
} from '@mantle/tools';
import { NO_SCOPE_ERROR } from '@mantle/std';
import { MANTLE_MCP_INSTRUCTIONS, registerMantleTools } from './build-server';
import { keyAreasReachEmail } from './key-scope';
import { keyEmailGuard } from './key-email-guard';
import { keyAreasAllowTool } from './mcp-policy';
import { mcpDefinition } from './mcp-defs';
import { mcpGateCaller } from './gate-policy';
import { registerGatedTool, type McpGate } from './gated-tools';
import type { LoginRole } from '@mantle/client-types/role-names';

export type McpLoginRole = LoginRole;

/** Who is on the other end of an /api/mcp request, resolved once from its
 *  bearer by the route (server/web/lib/mcp-auth.ts). */
export type McpCaller = {
  role: McpLoginRole;
  /** The brain (anchor) every content query is keyed to. */
  anchorId: string;
  /** The login acting: the consenting login, the token's login, or the
   *  login a peer is bound to. */
  loginId: string;
  displayName?: string | null;
  /** How the bearer was issued. */
  via: 'oauth' | 'peer' | 'key';
  /** Whether write tools are offered (admin OAuth: always). */
  write: boolean;
  /** A peer or an API key bound to the owner: the risky tools the owner
   *  allowed by name. */
  riskyAllowed?: readonly string[];
  /** The peer whose token this is (its own rate budget). */
  peerId?: string;
  /** A peer bound to the owner that the owner registered itself (W6b fix
   *  round 3, M-1): only then is its app_delete the owner's (purged after
   *  30 days). Any other peer's waits in the trash for the owner. */
  peerByOwner?: boolean;
  /** The inbound API key this is (migration 0232): its own rate budget. */
  keyId?: string;
  /** The OAuth client of an OAuth grant: the app data audit names it. */
  oauthClientId?: string;
  /** An API key's areas (`@mantle/mcp-core/key-scope`); null or absent =
   *  every area. Only a key sets it. */
  areas?: readonly string[] | null;
};

/** Whether a caller's areas (an API key's; null or absent = all) allow
 *  this tool. */
export function callerAreasAllow(slug: string, caller: Pick<McpCaller, 'areas'>): boolean {
  return keyAreasAllowTool(slug, caller.areas ?? null);
}

// ── The owner surface for a peer or a key ────────────────────────────────────

/*
 * Owner tools a PEER or an API key bound to the owner never gets unless the
 * owner named them on it: anything that sends outside the box or spends,
 * runs a shell or a container, publishes, or hands out privilege (Jason,
 * 2026-10-03), every tool that starts paid model work, waits for the
 * owner's confirm in the app (deletes, restores: the owner surface does not
 * hold that gate) or changes a mini app's code or grants (a published app
 * runs the change at once). The owner's own OAuth connector is not filtered
 * by this. Each such tool's policy says `peerRisky` (the builtins' and the
 * hand-written MCP tools'), and the gate's peer narrower reads it
 * (@mantle/tools gate-narrowers.ts). A5 step 6a deleted the
 * PEER_RISKY_TOOL_SLUGS view and the name-keyed isPeerRiskyTool,
 * ownerPeerAllows and isMcpToolReadOnly: a name no policy table holds (a
 * connector's tool) is judged by its row's own policy at the gate.
 */

/** Prefixes of whole risky families: Telegram, the CLI sandboxes, the web,
 *  and other peers (egress to a third brain on this brain's credentials).
 *  Every tool of these families declares `peerRisky` on its policy. Kept
 *  for the family sweep (tool-policy-sweep.test.ts), which holds every
 *  declared tool of a family to `peerRisky`. */
export const PEER_RISKY_TOOL_PREFIXES: readonly string[] = [
  'telegram_',
  'sandbox_',
  'web_',
  'peer_',
];

// ── One surface for every login (workspaces W7b) ─────────────────────────────

/** The connection as the builtins see it: how it connected and its Write
 *  switch (app_data_*), what the audit names it by, and whether it is
 *  outside an Admin scope (no spending on the owner's keys, M-a). */
function mcpChannel(caller: McpCaller, keysOff: boolean): LoginMcpChannel {
  return {
    via: caller.via,
    write: caller.write,
    role: caller.role,
    ...(keysOff ? { ownerKeysOff: true } : {}),
    ...(caller.keyId ? { keyId: caller.keyId } : {}),
    ...(caller.peerId ? { peerId: caller.peerId } : {}),
    ...(caller.oauthClientId ? { oauthClientId: caller.oauthClientId } : {}),
  };
}

/**
 * What the route prepares before the server registers (the MCP adapter
 * registers synchronously): refused (a login that is not an Admin user on
 * a brain not on workspaces), or the one
 * surface with what its scope may LIST, the login's private workspace (the
 * create rule's fallback) and the connector tools of its workspaces.
 */
export type PreparedCallerTools =
  | { kind: 'refused'; caller: McpCaller; message: string }
  | {
      kind: 'owner';
      caller: McpCaller;
      /** What the scope may list; null = everything (the Admin rollback
       *  switch, or a brain not on workspaces, for an Admin login). */
      view: AdminGateView | null;
      /** The login's private workspace when its scope does not hold Admin. */
      privateWs: string | null;
      /** The connector tools of the login's workspaces (team apps Phase 2),
       *  listed as the gate lists them (gateLists, like any tool). */
      connectors: Tool[];
      /** The login's scope (A5 step 4): a login in no workspace lists no
       *  tools at all (owner decision A). Null: unscoped (an Admin login on
       *  a brain not on workspaces). Absent: not read (a test's prepared
       *  connection; each call still enters the scope it reads). */
      scope?: WorkspaceScope | null;
    };

/** The refusal for a non-Admin login on a brain not on workspaces. */
export const NOT_ON_WORKSPACES_REFUSED =
  'This brain is not on workspaces yet, so only an admin login has MCP tools here.';

/** What the scope of `loginId` may list: whether it holds Admin, and its
 *  Admin areas. Read in the scope, once per connection. */
async function gateViewFor(loginId: string): Promise<AdminGateView> {
  const scope = await loginScopeFor(loginId);
  if (scope.ws.length === 0) return { holdsAdmin: false, areas: new Set() };
  return withTurnScope(scope, async () => {
    const holdsAdmin = await scopeHoldsAdmin();
    const areas = new Set<ScopeArea>();
    if (holdsAdmin) {
      for (const a of SCOPE_AREAS) if (await scopeHasArea(a)) areas.add(a);
    }
    return { holdsAdmin, areas };
  });
}

export async function prepareCallerTools(caller: McpCaller): Promise<PreparedCallerTools> {
  const admin = caller.role === 'admin';
  const onWorkspaces = await brainOnWorkspacesNow();
  if (!onWorkspaces && !admin) {
    return { kind: 'refused', caller, message: NOT_ON_WORKSPACES_REFUSED };
  }
  // The rollback switch restores the read path only (W7 integration fix 2,
  // M6): the listing still follows the login's areas.
  const unscoped = admin && !onWorkspaces;
  let view: AdminGateView | null = null;
  let privateWs: string | null = null;
  let scope: WorkspaceScope | null = null;
  if (!unscoped) {
    view = await gateViewFor(caller.loginId);
    scope = await loginScopeFor(caller.loginId);
    // The create rule's fallback for a user outside Admin (the W6b route
    // rule): made with the login, so only once it is in a workspace.
    if (!view.holdsAdmin && scope.ws.length > 0) {
      // THE create-home intent's fallback (@mantle/db createHomeIntent, arch
      // A3c), once per connection: it makes the private workspace when
      // there is none, and the login write gateway knows the pair from it
      // (arch A2b2b). Each create then asks the same function with it.
      const home = await createHomeIntent(caller.loginId, null, {
        ownWork: true,
        makePrivate: true,
      });
      privateWs = 'refused' in home ? null : home.privateWs;
    }
  }
  // Connector tools (team apps Phase 2; W5b2): the connector a resource of
  // one of the login's workspaces (the call's scope checks it again, and a
  // write tool's Write tick and Moderator there, in dispatch). Listed as
  // the gate lists them (A5 step 4, registerPreparedTools): a tool with the
  // admin's read-only mark reads, one without writes and needs the
  // connection's write; a connector tool is in no key area, so only an
  // all-areas key reaches it.
  const connectors = (await listLoginConnectorTools(caller.anchorId, caller.loginId)).map(
    (c) => c.tool,
  );
  return { kind: 'owner', caller, view, privateWs, connectors, scope };
}

/*
 * The tools that spend on the brain owner's provider keys: every tool whose
 * policy spends `ownerKey` (A5 step 6a deleted the OWNER_KEY_SPENDING_TOOLS
 * view and spendsOwnerKeys; the gate's spending narrower reads the policy):
 * the spending builtins (all but search_chunks), a crawl (Firecrawl
 * credits), a re-run of the extractor (model work per node), a turn of
 * another agent or of a responder (W7b fix round 1, M4), and a route map
 * (the owner's Mapbox key, W7 integration fix 2, M4). Outside an Admin
 * scope such a tool is not listed on MCP (a CEO default, reversible), so a
 * direct MCP, key or peer call of a user who is not a user of the Admin
 * workspace cannot reach it. A workspace assistant's turn keeps its own
 * rules (the member turn ledger limits), untouched here.
 *
 * Spending builtins that stay listed for every login spend `model`, not
 * `ownerKey`: search_chunks' query embedding is the one search_nodes makes
 * too, and its one paid step (the passage_scoring decider, up to 8
 * requests per search) is skipped on a connection outside an Admin scope
 * (`ownerKeysOff`, W7b fix round 2, M-a): such a login gets the plain
 * ranking.
 */

/** Whether the prepared surface is outside an Admin scope: nothing on it
 *  spends on the brain owner's keys (M4 lists no such tool; M-a: a listed
 *  tool skips its paid step). An unscoped Admin login (view null) is not. */
export function preparedKeysOff(prepared: PreparedCallerTools): boolean {
  return prepared.kind === 'owner' && prepared.view !== null && !prepared.view.holdsAdmin;
}

/** The ref a prepared connection lists `name` by: one of its connector
 *  rows, a hand-written MCP tool, else a builtin. */
function listedRef(prepared: PreparedCallerTools & { kind: 'owner' }, name: string): PolicyRef {
  const row = prepared.connectors.find((c) => c.slug === name);
  if (row) return { kind: 'runtime-tool', name, row };
  if (mcpDefinition(name)) return { kind: 'mcp-tool', name };
  return mcpBuiltinToolRef(name, name);
}

/** Whether the prepared connection lists the tool `name` (the one gate's
 *  listing, gateLists, by the ref the surface registers it under): what
 *  the route's audit of a key's write calls reads (`the tools this caller
 *  was given`). A refused connection lists nothing. Registration opt-ins
 *  (the terminal, the Toolsmith writes) are not read here. */
export function preparedLists(prepared: PreparedCallerTools, name: string): boolean {
  if (prepared.kind === 'refused') return false;
  const caller = mcpGateCaller(prepared);
  return caller !== null && gateLists(caller, listedRef(prepared, name));
}

/** One audit row per connector call a login makes over its own MCP (team
 *  apps Phase 2): the login, the tool and its connector, read or write,
 *  the connection, and for a write its input (capped; it can hold what
 *  the login typed, and the audit log is admins only). Best effort. */
function logConnectorCall(
  caller: McpCaller,
  row: Tool,
  args: Record<string, unknown>,
  write: boolean,
): void {
  let input: string | undefined;
  if (write) {
    try {
      input = JSON.stringify(args ?? {}).slice(0, CONNECTOR_LOG_INPUT_MAX);
    } catch {
      input = '[input not serialisable]';
    }
  }
  const handler = row.handler as { kind: 'mcp'; group: string; toolName: string };
  // This row is the call's audit row: the gate writes no `api.write` for it
  // (A5 step 6d, one row per write).
  markCallAudited();
  try {
    // As the system: the audit log is an admin table, and the caller runs
    // in its scope.
    void asSystem(
      () =>
        db.insert(auditLog).values({
          actorId: caller.loginId,
          actorEmail: `${caller.role} (mcp)`,
          action: write ? 'mcp.connector.write' : 'mcp.connector.read',
          method: 'MCP',
          path: '/api/mcp',
          detail: {
            tool: row.slug,
            group: handler.group,
            role: caller.role,
            connection: caller.via,
            ...(caller.keyId ? { keyId: caller.keyId } : {}),
            ...(caller.peerId ? { peerId: caller.peerId } : {}),
            ...(caller.oauthClientId ? { oauthClientId: caller.oauthClientId } : {}),
            ...(input !== undefined ? { input } : {}),
          },
        }),
      'audit-log',
    ).catch(() => {
      /* best effort: never fail the call over its log */
    });
  } catch {
    /* best effort */
  }
}

/** The longest input a connector write's audit row keeps. */
const CONNECTOR_LOG_INPUT_MAX = 2048;

/**
 * A connector row's own check, in its call's pre-run slot (A5 step 4): the
 * connector as a workspace resource (W4b fix round 1, M3), checked here
 * too: it must be one of the login's workspaces' resources, and a write
 * needs that resource's Write tick in a workspace the login moderates
 * (dispatch checks the call's scope again). Then the call's audit row.
 * Whether the connection may write at all is the gate's read-only
 * narrower: a connector tool that writes is not listed for a read-only
 * connection.
 */
export function connectorCheck(caller: McpCaller) {
  return async (row: Tool, args: Record<string, unknown>): Promise<string | null> => {
    // The connector tool's policy (arch A3c, runtime-policy.ts): a stale
    // (voided) mark counts as a write here; dispatch refuses it below the
    // owner anyway.
    const policy = connectorToolPolicy(row);
    const write = policy.effect === 'write';
    // A connection that only reads (a read-only key, peer or login) calls a
    // tool an Admin marked read-only with only the inputs it was marked
    // with, in any scope (A5 step 5 fix round 1, L2): dispatch applies the
    // mark below the owner and in a workspace scope, not to an owner
    // surface outside one, which a read-only admin key or peer can be.
    if (!caller.write) {
      const marked = connectorMarkRefusal(policy.fields.mark, row, args);
      if (marked !== null) return marked;
    }
    const refused = await loginConnectorRefused(
      caller.anchorId,
      caller.loginId,
      (row.handler as { group: string }).group,
      write,
    );
    if (refused) return refused;
    logConnectorCall(caller, row, args, write);
    return null;
  };
}

/**
 * Register the one surface for this caller (W7b): the owner tools and the
 * connector tools of its workspaces, each listed when the one gate lists
 * it for the connection and called through it (gated-tools.ts, A5 step 4;
 * the caller: gate-policy.ts mcpGateCaller). A refused caller gets nothing
 * (the route answers 403 first); a login in no workspace lists nothing
 * (owner decision A: the server instructions say why).
 */
export function registerPreparedTools(
  server: McpServer,
  prepared: PreparedCallerTools,
  opts: { transport?: 'stdio' | 'http' } = {},
): void {
  const gateCaller = mcpGateCaller(prepared);
  if (prepared.kind === 'refused' || !gateCaller) return;
  const { caller } = prepared;
  const adminRole = caller.role === 'admin';
  // Outside an Admin scope: nothing spends on the owner's keys (M-a).
  const keysOff = preparedKeysOff(prepared);
  const gate: McpGate = Object.freeze({
    lists: gateCaller,
    // One request: each call runs as the listing read it.
    callerFor: async () => gateCaller,
    // A key without Search does not reach email through Files (M4).
    ...(caller.via === 'key' && !keyAreasReachEmail(caller.areas ?? null)
      ? { guard: keyEmailGuard(caller.anchorId) }
      : {}),
    connector: connectorCheck(caller),
  });
  const channel = mcpChannel(caller, keysOff);
  const via = caller.via === 'key' ? 'api' : caller.via === 'peer' ? 'federation' : 'mcp';
  registerMantleTools(server, caller.anchorId, {
    transport: opts.transport ?? 'http',
    // A peer an admin did not register for the anchor names no login to the
    // builtins: an app its app_delete sends to Recently deleted waits there
    // for the owner, who alone deletes it for good (W6b fix round 3, M-1).
    ...(caller.via === 'peer' && adminRole && !caller.peerByOwner
      ? {}
      : { loginId: caller.loginId }),
    mcp: channel,
    ...(via !== 'mcp' ? { via } : {}),
    gate,
  });
  // The connectors, on the same server as every other tool: in the
  // login's scope and gate, and under its create home (W7b fix round 2,
  // L-a).
  const surface: ToolSurface = { kind: 'owner', via, loginId: caller.loginId, mcp: channel };
  for (const row of prepared.connectors) {
    registerGatedTool(server, gate, caller.anchorId, { kind: 'connector', row, surface });
  }
}

/** Whether a prepared connection is a login's in no workspace on a brain
 *  on workspaces: it lists no tools (owner decision A). */
function inNoWorkspace(prepared: PreparedCallerTools | undefined): boolean {
  return prepared?.kind === 'owner' && !!prepared.scope && prepared.scope.ws.length === 0;
}

/** The server instructions: Recall's hook, plus where creates land; for a
 *  login in no workspace, why it has no tools (A5 step 4, owner decision
 *  A). */
export function mcpInstructionsFor(_caller: McpCaller, prepared?: PreparedCallerTools): string {
  if (inNoWorkspace(prepared)) return MCP_NO_WORKSPACE_INSTRUCTIONS;
  return `${MANTLE_MCP_INSTRUCTIONS} ${MCP_WORKSPACE_INSTRUCTIONS}`;
}

/** What every login is told about its workspaces (W7b). */
export const MCP_WORKSPACE_INSTRUCTIONS =
  'You act as the signed-in user and read what their workspaces hold: workspaces_list shows them and where you are a Moderator. A create takes an optional workspace (one you moderate); without it the item lands in its folder’s workspace, else the user’s own private one (Admin for a user of the Admin workspace), and every create reply names where it landed (landedIn).';

/** What a login in no workspace is told (A5 step 4, owner decision A): it
 *  lists no tools, and why: the gate's no-scope words, then what follows. */
export const MCP_NO_WORKSPACE_INSTRUCTIONS = `${NO_SCOPE_ERROR} Until then this connection lists no tools.`;
