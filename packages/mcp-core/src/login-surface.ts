/**
 * MCP as a login (plan page e5b854dd, 2026-10-03).
 *
 * `/api/mcp` used to serve one caller: the owner, with every tool, through
 * `callBuiltin` (which runs `def.handler` directly). It now serves any LOGIN:
 *
 *  - an ADMIN (OAuth): the full owner surface, unchanged;
 *  - an admin bound to a PEER token: the owner surface, filtered by the
 *    peer's write switch and the risky-tool rule (`ownerPeerAllows`);
 *  - a MEMBER or a CLIENT (OAuth, a static login token, or a peer token):
 *    the tools that role's responder already has, nothing more, each call
 *    run through `dispatchTool` (so the owner-only gate and the declared
 *    preconditions run) inside `withViewer` at the login's level (so row
 *    level security decides what is read). Read-only unless write is on;
 *    write adds the draft tools of the login's own space, never a library
 *    write.
 *
 * `McpCaller` is the one context every MCP auth path resolves to, so a tool
 * that must act for the calling login (the forum's notifications and threads,
 * forum plan section 10a) reads it from the surface the call runs on, never
 * from model arguments.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import {
  agents,
  auditLog,
  db,
  asSystem,
  withViewer,
  type Tool,
  type ViewerLevel,
} from '@mantle/db';
import {
  APP_DATA_READ_TOOL_SLUGS,
  APP_DATA_WRITE_TOOL_SLUGS,
  CLIENT_TURN_TOOL_SLUGS,
  MY_APP_READ_TOOL_SLUGS,
  MY_APP_WRITE_TOOL_SLUGS,
  MY_SPACE_WRITE_TOOL_SLUGS,
  dispatchTool,
  connectorMarkState,
  getBuiltin,
  isBuiltinReadOnly,
  listLoginConnectorTools,
  isBuiltinSpending,
  resolveTools,
  type ToolHandlerContext,
} from '@mantle/tools';
import {
  TEAM_PRIVATE_READ_SLUGS,
  isTeamPrivateReadsEnabled,
  loadProfilePreferences,
} from '@mantle/content';
import { effectiveToolSlugs, resolveAgentToolGroups } from '@mantle/runtime/agent';
import { CLIENT_RESPONDER_SLUG, TEAM_RESPONDER_SLUG } from '@mantle/runtime/assistant';
import { errorMessage } from '@mantle/std';
import {
  MANTLE_MCP_INSTRUCTIONS,
  TOOLSMITH_WRITE_SLUGS,
  registerMantleTools,
} from './build-server';
import { zodShapeFromJsonSchema } from './register/zod-schema';
import { addTool } from './register/tool-input';
import { keyAreasAllowTool, keyAreasReachEmail } from './key-scope';
import { keyEmailGuard } from './key-email-guard';

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

// ── The owner surface for a peer ─────────────────────────────────────────────

/**
 * Owner tools a PEER bound to the owner never gets unless the owner named
 * them on that peer: anything that sends outside the box or spends, runs a
 * shell or a container, publishes, or hands out privilege (Jason,
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
    (slug.startsWith('app_') && !isBuiltinReadOnly(slug))
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

/** The owner tools a peer bound to the owner may call. */
export function ownerPeerAllows(
  slug: string,
  peer: { write: boolean; riskyAllowed?: readonly string[] },
): boolean {
  if (isPeerRiskyTool(slug) && !(peer.riskyAllowed ?? []).includes(slug)) return false;
  return peer.write || isMcpToolReadOnly(slug);
}

// ── The member and client surface ────────────────────────────────────────────

const ROLE_LEVEL: Record<'member' | 'client', ViewerLevel> = { member: 'team', client: 'client' };
const ROLE_AGENT: Record<'member' | 'client', string> = {
  member: TEAM_RESPONDER_SLUG,
  client: CLIENT_RESPONDER_SLUG,
};

/**
 * Whether a tool may be offered to a member or client over MCP at all,
 * whatever their groups say: a builtin (an http, recipe or connector tool's
 * egress is not classified: left out), never one that spends, never one
 * that waits for an approval nobody is there to give, never mcpOnly
 * (operator surface) and never ownerOnly. Without write: `readOnly` only.
 * With write: also the draft tools of the login's own space and the one
 * request each role may file, never a library write (a member's or
 * client's write is a draft for review; RLS would refuse the rest anyway).
 */
export function loginMayHaveTool(
  row: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm'>,
  write: boolean,
): boolean {
  if (row.handler.kind !== 'builtin' || row.handler.ref !== row.slug) return false;
  const def = getBuiltin(row.slug);
  if (!def || def.mcpOnly || def.ownerOnly || def.spends) return false;
  if (row.requiresConfirm || def.requiresConfirm) return false;
  if (def.readOnly === true || LOGIN_OWN_READ_TOOL_SLUGS.has(row.slug)) return true;
  return write && LOGIN_WRITE_TOOL_SLUGS.has(row.slug);
}

/** Reads of the login's OWN space: not flagged `readOnly` in the registry
 *  (they act for a login, not over the owner's data), but they only read. */
const LOGIN_OWN_READ_TOOL_SLUGS: ReadonlySet<string> = new Set(['my_items_list', 'my_item_open']);

/** The agent's app database reads, which a login's MCP never gets: the
 *  app_data_* tools replace them there (team apps Phase 1). */
export const LOGIN_REPLACED_APP_DB_SLUGS: readonly string[] = ['app_db_list', 'app_db_query'];

/** The only non-read tools a member or client gets, with write on. */
const LOGIN_WRITE_TOOL_SLUGS: ReadonlySet<string> = new Set([
  ...MY_SPACE_WRITE_TOOL_SLUGS,
  ...APP_DATA_WRITE_TOOL_SLUGS,
  ...MY_APP_WRITE_TOOL_SLUGS,
  'team_request_create',
  'client_request_create',
]);

/**
 * The tool rows a member or client gets on MCP, resolved LIVE from the
 * role's responder agent: its groups at the LOGIN's level (so an admin-level
 * group, `team-read-admin`, drops out even if the responder were raised),
 * the private reads only with the owner's `teamPrivateReads`, a client cut
 * to `CLIENT_TURN_TOOL_SLUGS` in code. With write: plus the draft tools of
 * the login's own space. Then `loginMayHaveTool`.
 */
export async function resolveLoginToolRows(
  caller: McpCaller & { role: 'member' | 'client' },
): Promise<{ rows: Tool[]; level: ViewerLevel; privateReads: boolean }> {
  const level = ROLE_LEVEL[caller.role];
  const prefs = await loadProfilePreferences(caller.anchorId);
  const privateReads = caller.role === 'member' && isTeamPrivateReadsEnabled(prefs);
  const rows = await withViewer(level, async () => {
    const [agent] = await db
      .select({ toolGroupSlugs: agents.toolGroupSlugs, audience: agents.audience })
      .from(agents)
      .where(
        and(
          eq(agents.ownerId, caller.anchorId),
          eq(agents.slug, ROLE_AGENT[caller.role]),
          eq(agents.enabled, true),
        ),
      )
      .limit(1);
    let slugs: string[] = [];
    // The role's responder must sit at the role's level, as for chat
    // (assertAgentForRole): a responder left at admin is "closed" to that
    // role, on MCP as in chat.
    if (agent && agent.audience === level) {
      const agentLevel = agent.audience as ViewerLevel;
      slugs = effectiveToolSlugs(
        await resolveAgentToolGroups(caller.anchorId, agent.toolGroupSlugs ?? [], agentLevel),
      );
    }
    if (caller.role === 'member' && !privateReads) {
      const hidden = new Set(TEAM_PRIVATE_READ_SLUGS);
      slugs = slugs.filter((s) => !hidden.has(s));
    }
    if (caller.role === 'client') {
      const allowed = new Set(CLIENT_TURN_TOOL_SLUGS);
      slugs = slugs.filter((s) => allowed.has(s));
    }
    // App data (team apps Phase 1): the app_data_* tools, never the agent's
    // app_db_* reads, which reach every app at the level with no per-app
    // switch. The app_data tools hold the app's MCP access switch and the
    // browser's read or write rule.
    const hiddenAppDb = new Set(LOGIN_REPLACED_APP_DB_SLUGS);
    slugs = slugs.filter((s) => !hiddenAppDb.has(s));
    if (slugs.length > 0) {
      // A member builds their own mini apps (team apps Phase 3): the
      // my_app_* tools, reads always, changes with write on. Never a
      // client's: a client builds no apps.
      const memberApps =
        caller.role === 'member'
          ? [...MY_APP_READ_TOOL_SLUGS, ...(caller.write ? MY_APP_WRITE_TOOL_SLUGS : [])]
          : [];
      const extra = [
        ...APP_DATA_READ_TOOL_SLUGS,
        ...(caller.write ? [...MY_SPACE_WRITE_TOOL_SLUGS, ...APP_DATA_WRITE_TOOL_SLUGS] : []),
        ...memberApps,
      ];
      slugs = [...slugs, ...extra.filter((s) => !slugs.includes(s))];
    }
    if (slugs.length === 0) return [];
    return resolveTools(caller.anchorId, slugs);
  });
  const builtins = rows.filter(
    (r) => loginMayHaveTool(r, caller.write) && callerAreasAllow(r.slug, caller),
  );
  // Connector tools (team apps Phase 2): those of a connector whose level
  // the login's level reads, outside the responder's groups and the
  // client cut (the connector's level is the grant). A tool with the
  // admin's read-only mark reads; one without writes, so it needs write
  // on. A connector tool is in no key area: only an all-areas key reaches
  // it (a connector can read anything its far side holds). Only while the
  // role's surface is open at all (its responder at the role's level).
  const connectors =
    builtins.length === 0
      ? []
      : (await listLoginConnectorTools(caller.anchorId, level))
          .filter((c) => (c.readOnly || caller.write) && callerAreasAllow(c.tool.slug, caller))
          .map((c) => c.tool);
  return { rows: [...builtins, ...connectors], level, privateReads };
}

/** The surface a member's or client's MCP call runs on: the login, stamped
 *  by the server. The my-space tools and the request tools read it. */
export function loginSurface(
  caller: McpCaller & { role: 'member' | 'client' },
  privateReads: boolean,
): NonNullable<ToolHandlerContext['surface']> {
  const contactName = caller.displayName ?? undefined;
  // The connection, for the tools that act only on the login's own MCP
  // (app_data_*): how it connected, its Write switch, and what the audit
  // names it by.
  const mcp = {
    via: caller.via,
    write: caller.write,
    ...(caller.keyId ? { keyId: caller.keyId } : {}),
    ...(caller.peerId ? { peerId: caller.peerId } : {}),
    ...(caller.oauthClientId ? { oauthClientId: caller.oauthClientId } : {}),
  };
  return caller.role === 'client'
    ? { kind: 'client', loginId: caller.loginId, contactName, mcp }
    : { kind: 'team', loginId: caller.loginId, contactName, privateReads, mcp };
}

/** The longest input a connector write's audit row keeps. */
const CONNECTOR_LOG_INPUT_MAX = 2048;

/** One audit row per connector call a login makes over its own MCP (team
 *  apps Phase 2): the login, the tool and its connector, read or write,
 *  the connection, and for a write its input (capped; it can hold what
 *  the login typed, and the audit log is admins only). Best effort. */
function logConnectorCall(
  caller: McpCaller & { role: 'member' | 'client' },
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
    // As the system: the audit log is an admin table, and the caller may
    // already run in a viewer scope.
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

/** Run one login tool: at the login's level, through dispatchTool. */
/** The audit row of a member's my_app_* change over MCP: the tool, the app
 *  id and the connection, never the file contents. */
function logMyAppCall(
  caller: McpCaller & { role: 'member' | 'client' },
  row: Tool,
  args: Record<string, unknown>,
): void {
  const appId = typeof args?.id === 'string' ? args.id.slice(0, 64) : undefined;
  // The history entry a snapshot restore or delete names (access matrix N6).
  const snapshotId =
    typeof args?.snapshot_id === 'string' ? args.snapshot_id.slice(0, 64) : undefined;
  void asSystem(() =>
    db.insert(auditLog).values({
      actorId: caller.loginId,
      actorEmail: `${caller.role} (mcp)`,
      action: `mcp.${row.slug}`,
      method: 'MCP',
      path: '/api/mcp',
      detail: {
        tool: row.slug,
        ...(appId ? { appId } : {}),
        ...(snapshotId ? { snapshotId } : {}),
        role: caller.role,
        connection: caller.via,
        ...(caller.keyId ? { keyId: caller.keyId } : {}),
        ...(caller.peerId ? { peerId: caller.peerId } : {}),
        ...(caller.oauthClientId ? { oauthClientId: caller.oauthClientId } : {}),
      },
    }),
  ).catch(() => {
    /* best effort: never fail the call over its log */
  });
}

export async function callLoginTool(
  caller: McpCaller & { role: 'member' | 'client' },
  row: Tool,
  args: Record<string, unknown>,
  level: ViewerLevel,
  privateReads: boolean,
) {
  if (row.handler.kind === 'mcp') {
    // A connector tool (team apps Phase 2): a write needs write on (the
    // surface lists none without it; this is the call's own check), and
    // every call is logged with the login.
    // A stale (voided) mark counts as a write here: dispatchMcp refuses it below
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
    logConnectorCall(caller, row, args, write);
  }
  // A member's change to their own app over MCP (team apps; access matrix
  // N8): an audit row naming the login, the tool and the app. A key's call
  // already has one (auditMcpKeyCall, /api/mcp); OAuth, token and peer
  // calls did not.
  if (caller.via !== 'key' && MY_APP_WRITE_TOOL_SLUGS.includes(row.slug)) {
    logMyAppCall(caller, row, args);
  }
  try {
    const result = await withViewer(level, () =>
      dispatchTool(row, args ?? {}, {
        ownerId: caller.anchorId,
        surface: loginSurface(caller, privateReads),
      }),
    );
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(stripVectors(result.output), null, 2) },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
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
 * Register what this caller may have, whoever it is. An admin on OAuth gets
 * today's full surface; an admin through a peer gets it filtered; a member
 * or client gets the login surface. The route resolves the tool rows BEFORE
 * building the handler (`prepareCallerTools`), because the MCP adapter
 * registers synchronously.
 */
export type PreparedCallerTools =
  | { kind: 'owner'; caller: McpCaller }
  | {
      kind: 'login';
      caller: McpCaller & { role: 'member' | 'client' };
      rows: Tool[];
      level: ViewerLevel;
      privateReads: boolean;
    };

export async function prepareCallerTools(caller: McpCaller): Promise<PreparedCallerTools> {
  if (caller.role === 'admin') return { kind: 'owner', caller };
  const login = caller as McpCaller & { role: 'member' | 'client' };
  const { rows, level, privateReads } = await resolveLoginToolRows(login);
  return { kind: 'login', caller: login, rows, level, privateReads };
}

/** Whether the prepared surface gives this caller `slug`: a login's rows,
 *  or the owner surface through the same filter registerPreparedTools uses
 *  (owner OAuth: every tool). */
export function preparedAllows(prepared: PreparedCallerTools, slug: string): boolean {
  if (prepared.kind === 'login') return prepared.rows.some((r) => r.slug === slug);
  const { caller } = prepared;
  if (caller.via === 'oauth') return true;
  return ownerPeerAllows(slug, caller) && callerAreasAllow(slug, caller);
}

export function registerPreparedTools(
  server: McpServer,
  prepared: PreparedCallerTools,
  opts: { transport?: 'stdio' | 'http' } = {},
): void {
  if (prepared.kind === 'owner') {
    const { caller } = prepared;
    if (caller.via === 'oauth') {
      registerMantleTools(server, caller.anchorId, { transport: opts.transport ?? 'http' });
      return;
    }
    // A peer or an API key acting as the owner: the risky-tool rule and
    // the write switch, and for a key its areas too.
    registerMantleTools(server, caller.anchorId, {
      transport: opts.transport ?? 'http',
      via: caller.via === 'key' ? 'api' : 'federation',
      allow: (slug) => ownerPeerAllows(slug, caller) && callerAreasAllow(slug, caller),
      // A key without Search does not reach email through Files (M4).
      ...(caller.via === 'key' && !keyAreasReachEmail(caller.areas ?? null)
        ? { guard: keyEmailGuard(caller.anchorId) }
        : {}),
    });
    return;
  }
  registerLoginRows(server, prepared);
}

/** Register a member's or client's resolved tool rows onto `server`. */
export function registerLoginRows(
  server: McpServer,
  prepared: Extract<PreparedCallerTools, { kind: 'login' }>,
): void {
  const { caller, rows, level, privateReads } = prepared;
  for (const row of rows) {
    // The builtin's own definition, as the owner surface registers it: the
    // row's copy of the schema can lag a release, and the zod shape drops
    // every argument the schema does not name.
    const def = getBuiltin(row.slug);
    addTool(
      server,
      row.slug,
      def?.description ?? row.description,
      zodShapeFromJsonSchema(
        def?.inputSchema ?? (row.inputSchema as Record<string, unknown>) ?? {},
      ),
      (args) => callLoginTool(caller, row, args as Record<string, unknown>, level, privateReads),
    );
  }
}

/** The server instructions for this caller: the owner's Recall hook, or a
 *  plain statement of who the connection acts as. */
export function mcpInstructionsFor(caller: McpCaller): string {
  if (caller.role === 'admin') return MANTLE_MCP_INSTRUCTIONS;
  const who = caller.role === 'member' ? 'a team member' : 'a client';
  const write = caller.write
    ? ' You may also create drafts in their own personal space (my_note_create, my_page_create, my_file_upload) and submit them for review (my_item_submit). Drafts reach the brain only when an admin accepts them. On mini apps an admin opened to MCP you may also change rows (app_data_write), never the schema.'
    : ' This connection is read-only.';
  const apps =
    ' Mini app data: app_data_list shows the apps an admin opened to MCP, then app_data_schema and app_data_query. Tools named mcp_* reach outside data sources (connectors) an admin opened at your level.';
  const build =
    caller.role !== 'member'
      ? ''
      : caller.write
        ? ' The member builds their own mini apps with the my_app_* tools (read my_app_guide first): private until the member shares it with the team in the app (never over MCP; my_app_unshare makes it private again) or submits it to an admin (my_app_submit). my_app_delete moves one of their apps to their trash, where nothing is removed (my_app_undelete brings it back). Their apps run tools at team rules at most.'
        : " my_app_list and my_app_get read the member's own mini apps; building them needs the Write switch.";
  return `This connection acts as ${who} of this brain, with exactly that login's rights: you see what they may see, nothing more.${write}${apps}${build}`;
}
