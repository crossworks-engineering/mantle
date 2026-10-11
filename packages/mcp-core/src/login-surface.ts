/**
 * MCP as a login (plan page e5b854dd, 2026-10-03), one surface for every
 * login since workspaces W7b (plan 7.4).
 *
 * `/api/mcp` serves any LOGIN the same owner surface (build-server.ts), each
 * call in that login's own scope (owner-scope.ts: the union of its
 * workspaces, Moderator where it is one), gated per call (admin-gate.ts):
 *
 *  - LISTED by the scope: an adminOnly (or ownerOnly, outside
 *    OWNER_ONLY_IN_SCOPE) tool only where the scope holds the Admin
 *    workspace, an Admin-area tool only where that area is on;
 *  - an API key, a peer, or an old static login token is narrowed further
 *    by its write switch and the risky-tool rule (`ownerPeerAllows`), a key
 *    by its areas too (plan 7.5 and 7.6: a key or a peer acts as its login
 *    and only narrows it). The login's own OAuth consent is not;
 *  - a create takes an optional `workspace` and names where it landed
 *    (create-home.ts);
 *  - a CLIENT login stays refused (no client exists yet, plan 21.9).
 *
 * The member and client tool sets, the per-login MCP switch and the
 * my_app_* tools went (W7b): a login carries no permission of its own.
 *
 * `McpCaller` is the one context every MCP auth path resolves to, so a tool
 * that must act for the calling login reads it from the surface the call
 * runs on, never from model arguments.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { sql } from 'drizzle-orm';
import {
  SCOPE_AREAS,
  asSystem,
  auditLog,
  brainOnWorkspacesNow,
  db,
  loginScopeFor,
  scopeHasArea,
  scopeHoldsAdmin,
  withTurnScope,
  type ScopeArea,
  type Tool,
} from '@mantle/db';
import {
  adminGateLists,
  connectorMarkState,
  dispatchTool,
  getBuiltin,
  isBuiltinReadOnly,
  isBuiltinSpending,
  listLoginConnectorTools,
  loginConnectorRefused,
  type AdminGateView,
  type LoginMcpChannel,
} from '@mantle/tools';
import { publicErrorMessage, publicToolError } from '@mantle/std';
import { watchDatabaseErrors } from '@mantle/std/db-watch';
import {
  MANTLE_MCP_INSTRUCTIONS,
  TOOLSMITH_WRITE_SLUGS,
  loginToolServer,
  registerMantleTools,
} from './build-server';
import { zodShapeFromJsonSchema } from './register/zod-schema';
import { addTool } from './register/tool-input';
import { withModelImages } from './register/model-images';
import { keyAreasAllowTool, keyAreasReachEmail } from './key-scope';
import { keyEmailGuard } from './key-email-guard';
import { ADMIN_KIND_CREATE_TOOL_SLUGS } from './create-home';

export type McpLoginRole = 'admin' | 'member' | 'client';

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
  via: 'oauth' | 'token' | 'peer' | 'key';
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

/**
 * Owner tools a PEER or an API key bound to the owner never gets unless the
 * owner named them on it: anything that sends outside the box or spends,
 * runs a shell or a container, publishes, or hands out privilege (Jason,
 * 2026-10-03). Every `spends` builtin is in it too (`isPeerRiskyTool`).
 * The owner's own OAuth connector is not filtered by this.
 */
export const PEER_RISKY_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'email_send',
  'run_terminal',
  'app_publish',
  'node_share',
  'page_share',
  'secret_create',
  'invoke_agent',
  'ask_responder',
  'ask_as_responder',
  'responder_turn_input',
  // Writes into the owner's conversation as one of their agents.
  'responder_turn_record',
  'access_set',
  'pending_approve',
  'pending_reject',
  'api_tool_test',
  'recipe_tool_test',
  // Mail out under the owner's address, and the allowlist that gates it
  // (a new contact also starts a paid inbound backfill).
  'email_page',
  'contact_create',
  'contact_update',
  // A run queues tool calls and workers that execute later as the owner,
  // outside this filter (audit H1).
  'run_plan',
  'run_append',
  // Model routing for every agent.
  'model_pool_set',
  'model_pool_remove',
  'video_ingest',
  ...TOOLSMITH_WRITE_SLUGS,
]);
/** Prefixes of whole risky families: Telegram, the CLI sandboxes, the web,
 *  and other peers (egress to a third brain on this brain's credentials). */
export const PEER_RISKY_TOOL_PREFIXES: readonly string[] = [
  'telegram_',
  'sandbox_',
  'web_',
  'peer_',
];

/**
 * Risky for a peer bound to the owner: listed by name or family, or it
 * spends, or it waits for the owner's confirm in the app (deletes, restores:
 * the owner surface does not hold that gate), or it changes a mini app's
 * code or grants (a published app runs the change at once).
 */
export function isPeerRiskyTool(slug: string): boolean {
  const def = getBuiltin(slug);
  return (
    PEER_RISKY_TOOL_SLUGS.has(slug) ||
    PEER_RISKY_TOOL_PREFIXES.some((p) => slug.startsWith(p)) ||
    isBuiltinSpending(slug) ||
    def?.requiresConfirm === true ||
    // App data rows are data, not the app's code (app_data_write is the
    // connection's own app data tool, held to the grant's Write).
    (slug.startsWith('app_') && !slug.startsWith('app_data_') && !isBuiltinReadOnly(slug))
  );
}

/** The hand-written MCP tools (register/*.ts) that only read. Every other
 *  hand-written tool counts as a write (default deny), like the registry's
 *  `readOnly`. mcp-core's surface test pins this against the live list. */
export const MCP_HANDWRITTEN_READ_ONLY: ReadonlySet<string> = new Set([
  'search',
  'tree_list',
  'file_get',
  'file_read',
  'page_get',
  'page_list',
  'table_get',
  'table_list',
  'table_rows_list',
]);

/** Whether an owner MCP tool only reads: a registry `readOnly` builtin or a
 *  read-only hand-written tool. Unknown = no. */
export function isMcpToolReadOnly(slug: string): boolean {
  return MCP_HANDWRITTEN_READ_ONLY.has(slug) || isBuiltinReadOnly(slug);
}

/** The owner tools a peer or a key bound to the owner may call: the owner's
 *  surface, narrowed (never widened) by its write switch and the risky
 *  tools the owner named on it. */
export function ownerPeerAllows(
  slug: string,
  peer: { write: boolean; riskyAllowed?: readonly string[] },
): boolean {
  if (isPeerRiskyTool(slug) && !(peer.riskyAllowed ?? []).includes(slug)) return false;
  return peer.write || isMcpToolReadOnly(slug);
}

// ── One surface for every login (workspaces W7b) ─────────────────────────────

/** The connection as the builtins see it: how it connected and its Write
 *  switch (app_data_*), what the audit names it by, and whether it is
 *  outside an Admin scope (no spending on the owner's keys, M-a). */
function mcpChannel(caller: McpCaller, keysOff: boolean): LoginMcpChannel {
  return {
    via: caller.via,
    write: caller.write,
    ...(keysOff ? { ownerKeysOff: true } : {}),
    ...(caller.keyId ? { keyId: caller.keyId } : {}),
    ...(caller.peerId ? { peerId: caller.peerId } : {}),
    ...(caller.oauthClientId ? { oauthClientId: caller.oauthClientId } : {}),
  };
}

/** Whether the caller is narrowed like a peer: an API key, a peer, or an
 *  old static login token (made by an admin for the login, never by it).
 *  OAuth (the login's own consent) is not. */
function narrowed(caller: McpCaller): boolean {
  return caller.via !== 'oauth';
}

/**
 * What the route prepares before the server registers (the MCP adapter
 * registers synchronously): refused (a client login, plan 21.9; a login
 * that is not an Admin user on a brain not on workspaces), or the one
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
       *  narrowed like any tool. */
      connectors: Tool[];
    };

/** The refusal for a client login (no client exists yet, plan 21.9). */
export const CLIENT_LOGIN_REFUSED =
  'A client login has no MCP tools on this brain. Ask an admin of this brain.';

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

/** The login's private workspace, made now when it has none (plan 21.8
 *  row 8: it comes with the login). System pool. */
async function privateWorkspaceOf(loginId: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`select "public"."mantle_ws_private_workspace"(${loginId}::uuid)::text as ws`,
  )) as unknown as { ws: string | null }[];
  return rows[0]?.ws ?? null;
}

export async function prepareCallerTools(caller: McpCaller): Promise<PreparedCallerTools> {
  if (caller.role === 'client') return { kind: 'refused', caller, message: CLIENT_LOGIN_REFUSED };
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
  if (!unscoped) {
    view = await gateViewFor(caller.loginId);
    // The create rule's fallback for a user outside Admin (the W6b route
    // rule): made with the login, so only once it is in a workspace.
    if (!view.holdsAdmin && (await loginScopeFor(caller.loginId)).ws.length > 0) {
      privateWs = await privateWorkspaceOf(caller.loginId);
    }
  }
  // Connector tools (team apps Phase 2; W5b2): the connector a resource of
  // one of the login's workspaces (the call's scope checks it again, and a
  // write tool's Write tick and Moderator there, in dispatch). A tool with
  // the admin's read-only mark reads; one without writes, so it needs the
  // connection's write. A connector tool is in no key area: only an
  // all-areas key reaches it.
  const connectors = (await listLoginConnectorTools(caller.anchorId, caller.loginId))
    .filter((c) => (c.readOnly || caller.write) && callerAreasAllow(c.tool.slug, caller))
    .map((c) => c.tool);
  return { kind: 'owner', caller, view, privateWs, connectors };
}

/**
 * The tools that spend on the brain owner's provider keys besides the
 * registry's `spends` builtins: a crawl (Firecrawl credits), a re-run of the
 * extractor (model work per node), a turn of another agent or of a
 * responder (W7b fix round 1, M4), and a route map (the owner's Mapbox
 * key, W7 integration fix 2, M4).
 */
export const OWNER_KEY_SPENDING_TOOLS: ReadonlySet<string> = new Set([
  'web_crawl',
  'route_map',
  'process_extraction',
  'invoke_agent',
  'ask_responder',
  'ask_as_responder',
]);

/** Spending builtins that stay listed for every login: search_chunks' query
 *  embedding is the one search_nodes makes too, and its one paid step (the
 *  passage_scoring decider, up to 8 requests per search) is skipped on a
 *  connection outside an Admin scope (`ownerKeysOff`, W7b fix round 2,
 *  M-a): such a login gets the plain ranking. */
const SPENDING_KEPT: ReadonlySet<string> = new Set(['search_chunks']);

/**
 * Whether a tool spends on the brain owner's keys (W7b fix round 1, M4: a
 * CEO default, reversible). Outside an Admin scope such a tool is not
 * listed on MCP, so a direct MCP, key or peer call of a user who is not a
 * user of the Admin workspace cannot reach it. A workspace assistant's turn
 * keeps its own rules (the member turn ledger limits), untouched here.
 */
export function spendsOwnerKeys(slug: string): boolean {
  if (SPENDING_KEPT.has(slug)) return false;
  return isBuiltinSpending(slug) || OWNER_KEY_SPENDING_TOOLS.has(slug);
}

/** Whether the prepared surface is outside an Admin scope: nothing on it
 *  spends on the brain owner's keys (M4 lists no such tool; M-a: a listed
 *  tool skips its paid step). An unscoped Admin login (view null) is not. */
export function preparedKeysOff(prepared: PreparedCallerTools): boolean {
  return prepared.kind === 'owner' && prepared.view !== null && !prepared.view.holdsAdmin;
}

/** Whether the prepared surface LISTS `slug` for this caller: the scope's
 *  listing (adminOnly and Admin-area tools only where the scope holds
 *  them; outside Admin, no Admin-only kind's create and nothing that
 *  spends on the owner's keys), then a key's, a peer's or a static
 *  token's narrowing. A tool not listed is not registered: a call of it
 *  is refused as an unknown tool. */
export function preparedAllows(prepared: PreparedCallerTools, slug: string): boolean {
  if (prepared.kind === 'refused') return false;
  const { caller, view } = prepared;
  if (view && !adminGateLists(slug, view, { ownerOnly: getBuiltin(slug)?.ownerOnly })) {
    return false;
  }
  if (
    view &&
    !view.holdsAdmin &&
    (ADMIN_KIND_CREATE_TOOL_SLUGS.has(slug) || spendsOwnerKeys(slug))
  ) {
    return false;
  }
  // A read-only connection (a key or a peer with Write off, an OAuth grant
  // narrowed by 0268) lists only the tools that read.
  if (!caller.write && !isMcpToolReadOnly(slug)) return false;
  if (!narrowed(caller)) return true;
  return ownerPeerAllows(slug, caller) && callerAreasAllow(slug, caller);
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
  try {
    // As the system: the audit log is an admin table, and the caller runs
    // in its scope.
    void asSystem(() =>
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
    ).catch(() => {
      /* best effort: never fail the call over its log */
    });
  } catch {
    /* best effort */
  }
}

/** The longest input a connector write's audit row keeps. */
const CONNECTOR_LOG_INPUT_MAX = 2048;

/** Run one connector tool for the caller (already in its scope, through
 *  the scope wrapper): a write needs the connection's write, dispatchTool
 *  checks the connector against the scope, and the call is logged. */
async function callConnectorTool(
  caller: McpCaller,
  row: Tool,
  args: Record<string, unknown>,
  keysOff: boolean,
) {
  // A stale (voided) mark counts as a write here: dispatch refuses it below
  // the owner anyway (connectorMarkState).
  const write = connectorMarkState(row) !== 'read';
  if (write && !caller.write) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: This connector tool writes, and your MCP connection is read-only.',
        },
      ],
      isError: true,
    };
  }
  // The connector as a workspace resource (W4b fix round 1, M3), checked
  // here too: it must be one of the login's workspaces' resources, and a
  // write needs that resource's Write tick in a workspace the login
  // moderates. Dispatch checks the call's scope again.
  const refused = await loginConnectorRefused(
    caller.anchorId,
    caller.loginId,
    (row.handler as { group: string }).group,
    write,
  );
  if (refused) {
    return { content: [{ type: 'text' as const, text: `Error: ${refused}` }], isError: true };
  }
  logConnectorCall(caller, row, args, write);
  try {
    const { value: result, texts } = await watchDatabaseErrors(() =>
      dispatchTool(row, args ?? {}, {
        ownerId: caller.anchorId,
        surface: {
          kind: 'owner',
          via: caller.via === 'key' ? 'api' : caller.via === 'peer' ? 'federation' : 'mcp',
          loginId: caller.loginId,
          mcp: mcpChannel(caller, keysOff),
        },
      }),
    );
    if (!result.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${publicToolError(result.error, texts, `mcp ${row.slug}`)}`,
          },
        ],
        isError: true,
      };
    }
    return withModelImages(
      {
        content: [
          { type: 'text' as const, text: JSON.stringify(stripVectors(result.output), null, 2) },
        ],
      },
      result.modelImages,
    );
  } catch (err) {
    return {
      content: [
        { type: 'text' as const, text: `Error: ${publicErrorMessage(err, `mcp ${row.slug}`)}` },
      ],
      isError: true,
    };
  }
}

const STRIP_KEYS = new Set(['embedding', 'searchTsv', 'search_tsv']);
function stripVectors<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripVectors(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!STRIP_KEYS.has(k)) out[k] = stripVectors(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Register the one surface for this caller (W7b): the owner tools in the
 * login's scope (owner-scope.ts: every call gated again), listed as the
 * scope may (preparedAllows), plus the connector tools of its workspaces.
 * A refused caller gets nothing (the route answers 403 first).
 */
export function registerPreparedTools(
  server: McpServer,
  prepared: PreparedCallerTools,
  opts: { transport?: 'stdio' | 'http' } = {},
): void {
  if (prepared.kind === 'refused') return;
  const { caller } = prepared;
  const adminLogin = caller.role === 'admin';
  const allow = (slug: string) => preparedAllows(prepared, slug);
  // Outside an Admin scope: nothing spends on the owner's keys (M-a), and
  // a login in no workspace has no private one, so its creates are refused
  // with a reply that says why (create-home.ts).
  const keysOff = preparedKeysOff(prepared);
  const noCreateHome = keysOff && !prepared.privateWs;
  registerMantleTools(server, caller.anchorId, {
    transport: opts.transport ?? 'http',
    // A peer an admin did not register for the anchor names no login to the
    // builtins: its app_delete is held for the owner (W6b fix round 3, M-1).
    ...(caller.via === 'peer' && adminLogin && !caller.peerByOwner
      ? {}
      : { loginId: caller.loginId }),
    // Every call runs in the login's scope (W7a; every login since W7b).
    scopeLoginId: caller.loginId,
    adminLogin,
    privateWs: prepared.privateWs,
    noCreateHome,
    mcp: mcpChannel(caller, keysOff),
    ...(caller.via === 'key' ? { via: 'api' as const } : {}),
    ...(caller.via === 'peer' ? { via: 'federation' as const } : {}),
    allow,
    // A key without Search does not reach email through Files (M4).
    ...(caller.via === 'key' && !keyAreasReachEmail(caller.areas ?? null)
      ? { guard: keyEmailGuard(caller.anchorId) }
      : {}),
  });
  // The connectors, on the same server as every other tool: in the
  // login's scope and gate, and under its create home (W7b fix round 2,
  // L-a).
  const scoped = loginToolServer(server, caller.loginId, {
    adminLogin,
    privateWs: prepared.privateWs,
    noCreateHome,
  });
  for (const row of prepared.connectors) {
    if (!allow(row.slug)) continue;
    addTool(
      scoped,
      row.slug,
      row.description,
      zodShapeFromJsonSchema((row.inputSchema as Record<string, unknown>) ?? {}),
      (args) => callConnectorTool(caller, row, args as Record<string, unknown>, keysOff),
    );
  }
}

/** The server instructions: Recall's hook, plus where creates land. A
 *  client login is refused before it gets here. */
export function mcpInstructionsFor(caller: McpCaller): string {
  if (caller.role === 'client') return CLIENT_LOGIN_REFUSED;
  return `${MANTLE_MCP_INSTRUCTIONS} ${MCP_WORKSPACE_INSTRUCTIONS}`;
}

/** What every login is told about its workspaces (W7b). */
export const MCP_WORKSPACE_INSTRUCTIONS =
  'You act as the signed-in user and read what their workspaces hold: workspaces_list shows them and where you are a Moderator. A create takes an optional workspace (one you moderate); without it the item lands in its folder’s workspace, else the user’s own private one (Admin for a user of the Admin workspace), and every create reply names where it landed (landedIn).';
