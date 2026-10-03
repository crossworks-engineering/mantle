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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { agents, db, withViewer, type Tool, type ViewerLevel } from '@mantle/db';
import {
  CLIENT_TURN_TOOL_SLUGS,
  MY_SPACE_WRITE_TOOL_SLUGS,
  dispatchTool,
  getBuiltin,
  isBuiltinReadOnly,
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
  via: 'oauth' | 'token' | 'peer';
  /** Whether write tools are offered (admin OAuth: always). */
  write: boolean;
  /** A peer bound to the owner: the risky tools the owner allowed by name. */
  riskyAllowed?: readonly string[];
};

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
  'access_set',
  'pending_approve',
  'pending_reject',
  'api_tool_test',
  ...TOOLSMITH_WRITE_SLUGS,
]);
/** Prefixes of whole risky families: Telegram, the CLI sandboxes, the web. */
export const PEER_RISKY_TOOL_PREFIXES: readonly string[] = ['telegram_', 'sandbox_', 'web_'];

export function isPeerRiskyTool(slug: string): boolean {
  return (
    PEER_RISKY_TOOL_SLUGS.has(slug) ||
    PEER_RISKY_TOOL_PREFIXES.some((p) => slug.startsWith(p)) ||
    isBuiltinSpending(slug) ||
    slug === 'video_ingest'
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
  if (def.readOnly === true) return true;
  return write && LOGIN_WRITE_TOOL_SLUGS.has(row.slug);
}

/** The only non-read tools a member or client gets, with write on. */
const LOGIN_WRITE_TOOL_SLUGS: ReadonlySet<string> = new Set([
  ...MY_SPACE_WRITE_TOOL_SLUGS,
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
    if (agent) {
      const agentLevel = (agent.audience ?? 'admin') as ViewerLevel;
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
    if (caller.write)
      slugs = [...slugs, ...MY_SPACE_WRITE_TOOL_SLUGS.filter((s) => !slugs.includes(s))];
    if (slugs.length === 0) return [];
    return resolveTools(caller.anchorId, slugs);
  });
  return { rows: rows.filter((r) => loginMayHaveTool(r, caller.write)), level, privateReads };
}

/** The surface a member's or client's MCP call runs on: the login, stamped
 *  by the server. The my-space tools and the request tools read it. */
export function loginSurface(
  caller: McpCaller & { role: 'member' | 'client' },
  privateReads: boolean,
): NonNullable<ToolHandlerContext['surface']> {
  const contactName = caller.displayName ?? undefined;
  return caller.role === 'client'
    ? { kind: 'client', loginId: caller.loginId, contactName }
    : { kind: 'team', loginId: caller.loginId, contactName, privateReads };
}

/** Run one login tool: at the login's level, through dispatchTool. */
export async function callLoginTool(
  caller: McpCaller & { role: 'member' | 'client' },
  row: Tool,
  args: Record<string, unknown>,
  level: ViewerLevel,
  privateReads: boolean,
) {
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
    registerMantleTools(server, caller.anchorId, {
      transport: opts.transport ?? 'http',
      via: 'federation',
      allow: (slug) => ownerPeerAllows(slug, caller),
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
    server.tool(
      row.slug,
      row.description,
      zodShapeFromJsonSchema((row.inputSchema as Record<string, unknown>) ?? {}),
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
    ? ' You may also create drafts in their own personal space (my_note_create, my_page_create, my_file_upload) and submit them for review (my_item_submit). Drafts reach the brain only when an admin accepts them.'
    : ' This connection is read-only.';
  return `This connection acts as ${who} of this brain, with exactly that login's rights: you see what they may see, nothing more.${write}`;
}
