/**
 * "External access": the admin's switch on ONE outside tool (docs/
 * member-logins.md, "External access: outside tools in shared apps").
 * Decided 2026-10-01 as "Team apps may use"; widened and renamed 2026-10-02:
 * whoever an app is shared with may need the site service it calls.
 *
 * Below admin, an app's run may call only read-only built-in tools (member-
 * app-tools.ts, client-app-tools.ts; and the Table row writes on a Table
 * homed in a workspace that holds the app, rule 6), and a share link none:
 * an app loop has no model in between, and the brain cannot judge what an
 * outside tool does.
 * Every site adds its own connectors (an MCP server, an http API), so the
 * way through is data on the tool row, set by an admin who confirms the tool
 * only reads:
 *
 *  - only mcp and http tools may get it. Never recipe (its steps can call
 *    writing tools and change when a step tool changes) and never shell (a
 *    shell on the brain). Built-ins need none: they carry `readOnly`.
 *  - an http tool must not be PUT, PATCH or DELETE (writes by name);
 *  - a tool that requires confirmation cannot get it (nobody is there to
 *    confirm in an app loop);
 *  - only an admin switches it on: the owner REST API (admin logins only),
 *    the owner's own MCP client or the dev tool console. An in-brain agent
 *    may switch it off, never on.
 *
 * WHO may then call it is the app's sharing, nothing else: a member running
 * a team or public app, anyone running a client app (the client rules), and
 * a contact on a contact-share link who passed the code. Never an open link
 * (no contact). Each still needs the app to declare the tool, and the call
 * may come by hand with any input, not only from the app's screens.
 *
 * CONNECTOR tools (mcp) follow another rule (connectorToolVerdict below):
 * the workspaces that hold the connector decide who may use them (plan
 * section 6; from W5b2 the connector's level no longer does, it only says
 * which agents may hold the group), and the confirm stored here is their
 * READ-ONLY MARK (marked = a read, unmarked = a write). The switch's
 * eligibility and signature rules hold for the mark as they did for the
 * switch.
 *
 * The row stores WHEN the admin confirmed, WHO, and a signature of the
 * handler they looked at. The switch counts only while that signature equals
 * the current handler's, so any change to the handler voids it, whoever made
 * it (an edit, a connector sync, SQL by hand). `updateTool` also clears it on
 * such a change, and a connector moved to another server or credential
 * clears it on every tool of that connector, so the UI shows it off.
 * Deleting the tool deletes the row and the switch with it. Every call,
 * allowed or refused, is logged with the member, client or contact.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  asSystem,
  systemWork,
  auditLog,
  db,
  toolGroups,
  tools,
  type Tool,
  type ToolHandler,
  type ToolExternalAccess,
  wsArraySql,
} from '@mantle/db';
import type { ToolExternalAccessDTO } from '@mantle/client-types';
import { resolveTool } from './resolve';
import type { RuntimeToolPolicy } from './runtime-policy';

/**
 * The connector binding door (arch A6): a connector's tool group row (its MCP
 * binding, its OAuth config) is infrastructure, read on the system pool by the
 * named reason 'connector-binding'. Every such read goes through it: here, and
 * dispatch.ts through connectorGroupRow.
 */
function connectorBindingSystem<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(fn, 'connector-binding');
}

/** The same rows for a caller that never runs in a scope (A6b): a login's
 *  MCP listing (/api/mcp's bearer path and a member's own MCP screen, both
 *  on the system pool). systemWork runs it as asSystem did and refuses a
 *  scope (no exit). */
function connectorBindingSystemWork<T>(fn: () => Promise<T>): Promise<T> {
  return systemWork(fn, 'connector-binding');
}

/** The handler kinds an admin may open to external access. */
export const EXTERNAL_ACCESS_KINDS: readonly ToolHandler['kind'][] = ['mcp', 'http'];

/** http methods that write by name: never opened to external access. */
const WRITE_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

/** JSON with sorted keys, so the same handler always hashes the same (and
 *  a jsonb round trip, which reorders keys, compares equal). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The signature of what a tool does: its handler without the bookkeeping a
 * sync writes (`vanishedAt` on an mcp row, `vanishedAt` / `editedAt` on an
 * OpenAPI mirror), so a remote tool that blinks out and back, or an edit to
 * the name, keeps the switch. Anything else in the handler counts.
 */
export function externalAccessHandlerSig(handler: ToolHandler): string {
  let h: Record<string, unknown> = { ...(handler as Record<string, unknown>) };
  if (handler.kind === 'mcp') {
    delete h.vanishedAt;
  } else if (handler.kind === 'http' && handler.openapi) {
    const { vanishedAt: _v, editedAt: _e, ...openapi } = handler.openapi;
    h = { ...h, openapi };
  }
  return createHash('sha256').update(canonical(h)).digest('hex');
}

/**
 * The signature a NEW mark carries (access matrix N4): for a connector tool
 * it also covers the tool's description and input schema, which a sync
 * rewrites when the remote tool changes (a new parameter that runs any
 * statement must not keep the mark). Prefixed `v2:`; a mark from before
 * carries the handler signature alone and is still read as one, while the
 * sync voids it on any change of description or schema. Any other tool:
 * the handler signature, as before.
 */
export function externalAccessToolSig(
  tool: Pick<Tool, 'handler' | 'description' | 'inputSchema'>,
): string {
  const handler = tool.handler as ToolHandler;
  if (handler.kind !== 'mcp') return externalAccessHandlerSig(handler);
  const { vanishedAt: _v, ...h } = handler as Record<string, unknown>;
  return (
    'v2:' +
    createHash('sha256')
      .update(canonical({ h, d: tool.description ?? '', s: tool.inputSchema ?? null }))
      .digest('hex')
  );
}

/** Whether a stored mark signature still matches `tool`. */
function markMatches(
  sig: string,
  tool: Pick<Tool, 'handler' | 'description' | 'inputSchema'>,
): boolean {
  return sig.startsWith('v2:')
    ? sig === externalAccessToolSig(tool)
    : sig === externalAccessHandlerSig(tool.handler as ToolHandler);
}

/** Why `tool` can never get external access as it stands, else null. */
export function externalAccessIneligible(
  tool: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm'>,
): string | null {
  const h = tool.handler as ToolHandler;
  if (h.kind === 'builtin') {
    return `The tool '${tool.slug}' is built in: shared apps may use it when it is read-only and in an enabled tool group at their level, with no switch.`;
  }
  if (h.kind === 'shell') {
    return `The tool '${tool.slug}' is a shell tool, and a shell tool can never get external access.`;
  }
  if (h.kind === 'recipe') {
    return `The tool '${tool.slug}' is a recipe, and a recipe can never get external access (its steps can call tools that write).`;
  }
  if (!EXTERNAL_ACCESS_KINDS.includes(h.kind)) {
    return `The tool '${tool.slug}' can't get external access.`;
  }
  if (h.kind === 'http' && WRITE_METHODS.has(h.method ?? 'GET')) {
    return `The tool '${tool.slug}' sends ${h.method}, which changes data, so it can't get external access.`;
  }
  if (tool.requiresConfirm) {
    return `The tool '${tool.slug}' needs an admin's confirmation on every call, so it can't get external access (nobody is there to confirm).`;
  }
  return null;
}

/** Whether the admin's switch counts on `tool` right now: set, still on the
 *  handler the admin confirmed, and the tool still eligible. */
export function externalAccessActive(
  tool: Pick<
    Tool,
    'slug' | 'handler' | 'requiresConfirm' | 'externalAccess' | 'description' | 'inputSchema'
  >,
): boolean {
  const t = tool.externalAccess;
  if (!t || typeof t !== 'object' || typeof t.handlerSig !== 'string') return false;
  if (externalAccessIneligible(tool) !== null) return false;
  return markMatches(t.handlerSig, tool);
}

/** The signature a voided read-only mark carries: never a handler's. */
export const VOIDED_MARK_SIG = 'voided';

/**
 * A connector tool's mark (team apps Phase 2): `read` (marked, on the
 * handler the admin looked at), `write` (never marked), or `stale` (marked
 * once, but the handler or the connector changed since). A stale tool is
 * refused below the owner until an admin marks it again: a change never
 * turns a read into a write by itself (M2 audit, low 5).
 */
export function connectorMarkState(
  tool: Pick<
    Tool,
    'slug' | 'handler' | 'requiresConfirm' | 'externalAccess' | 'description' | 'inputSchema'
  >,
): 'read' | 'write' | 'stale' {
  if (!tool.externalAccess) return 'write';
  return externalAccessActive(tool) ? 'read' : 'stale';
}

/**
 * A connector tool's policy (workspaces arch A3c, plan section 8: one
 * function per runtime tool row type, runtime-policy.ts). It comes from the
 * row and the connector's workspace resource rows: the admin's read-only
 * mark makes it a read, its absence a write (a stale mark counts as a
 * write, and is refused below the owner); a call needs the connector to be
 * a resource of a workspace of the caller's, and a write needs that row's
 * Write tick in a workspace where the caller is a Moderator
 * (loginConnectorRule: the one rule that checks it). Every connector path
 * reads the mark through this: the login's MCP listing and call, an app
 * run's verdict and dispatch. For a key or a peer (the gate's peer
 * narrower, A5 step 2) it is declared not risky, and its effect decides a
 * read-only key or peer as any caller's (A5 step 5, owner decision Q1 b).
 */
export function connectorToolPolicy(
  tool: Pick<
    Tool,
    'slug' | 'handler' | 'requiresConfirm' | 'externalAccess' | 'description' | 'inputSchema'
  >,
): ConnectorToolPolicy {
  const mark = connectorMarkState(tool);
  const group = (tool.handler as { group?: unknown }).group;
  const write = mark !== 'read';
  return Object.freeze({
    rowType: 'connector' as const,
    effect: write ? ('write' as const) : ('read' as const),
    scope: 'any' as const,
    spends: 'none' as const,
    fields: Object.freeze({
      mark,
      resource: Object.freeze({
        type: 'connector',
        ref: typeof group === 'string' ? group : '',
        writeTick: write,
      }),
      requiresConfirm: tool.requiresConfirm === true,
      peerRisky: false,
    }),
  });
}

/** What connectorToolPolicy says (a RuntimeToolPolicy, runtime-policy.ts). */
export type ConnectorToolPolicy = RuntimeToolPolicy & {
  readonly rowType: 'connector';
  readonly fields: Readonly<{
    mark: 'read' | 'write' | 'stale';
    resource: Readonly<{ type: 'connector'; ref: string; writeTick: boolean }>;
    requiresConfirm: boolean;
    peerRisky: false;
  }>;
};

/** Who runs a shared app, for the refusal's words. */
export type ExternalAccessRunner = 'member' | 'client' | 'contact';

export type ExternalToolVerdict =
  { ok: true; tool: Tool } | { ok: false; status: 403; reason: string };

/**
 * The ONE rule for an outside (non-built-in) tool in an app run below admin:
 * a member's (member-app-tools.ts), a client app's (client-app-tools.ts) and a
 * contact link's (the /s tool broker). The caller has checked that the app
 * declares the tool and resolved the enabled row. Nothing else gates it: the
 * app's sharing decided who runs the app (decided 2026-10-02).
 */
export function externalToolVerdict(
  tool: Tool,
  slug: string,
  runner: ExternalAccessRunner,
): ExternalToolVerdict {
  if (externalAccessActive(tool)) return { ok: true, tool };
  const who =
    runner === 'member' ? 'a team app' : runner === 'client' ? 'a client app' : 'a shared link';
  return {
    ok: false,
    status: 403,
    reason: `The tool '${slug}' can't be used from ${who}: it is an outside tool without External access. An admin can switch External access on for a tool that only reads (Settings → Tools).`,
  };
}

// ── Connector tools: the workspaces that hold the connector decide ──────────

/** An outside tool's verdict, and whether the call writes: a connector tool
 *  without the admin's read-only mark is a write tool. */
export type OutsideToolVerdict =
  { ok: true; tool: Tool; write: boolean } | { ok: false; status: 403; reason: string };

/** The connector group of a connector tool (its handler names it: the one
 *  link a sync, a dispatch and the switch clearing all use), or null. */
export async function connectorGroupOf(
  ownerId: string,
  tool: Pick<Tool, 'handler'>,
): Promise<{ id: string; slug: string; usable: boolean } | null> {
  const h = tool.handler as ToolHandler;
  if (h.kind !== 'mcp') return null;
  // By its definer (mantle_connector_state, 0293): a limited scope's row
  // security may hide the group, and the caller needs only its state, never
  // its binding (A6b: the whole row on the system pool before).
  const [g] = (await db.execute(
    sql`select id::text as id, slug, usable
          from "public"."mantle_connector_state"(${ownerId}::uuid, ${h.group})`,
  )) as unknown as { id: string; slug: string; usable: boolean }[];
  if (!g) return null;
  return { id: g.id, slug: g.slug, usable: g.usable === true };
}

/**
 * The tool group `slug` of brain `ownerId`, the whole row (its MCP binding,
 * its OAuth config), or undefined: the one read of a connector's binding
 * outside this file (dispatch.ts: an MCP call and an OAuth ref; arch A6
 * folded its two copies here). The caller learns nothing from it but what
 * the call then does.
 */
export async function connectorGroupRow(ownerId: string, slug: string) {
  const [group] = await connectorBindingSystem(() =>
    db
      .select()
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)))
      .limit(1),
  );
  return group;
}

/**
 * A connector as a workspace resource (workspaces plan section 6, W4b): the
 * rows that put the connector group `groupSlug` on any of `wsIds` (live,
 * unarchived workspaces of the brain), with their Write tick. By its
 * definer (mantle_connector_rows, 0293: the rule is in the query; A6b: on
 * the system pool before, 'workspace-resources'). Not held to the running
 * scope's workspaces: a caller names the scope it asks about (the approval
 * re-check asks the asked scope's rows from the approver's scope).
 */
export async function connectorResources(
  ownerId: string,
  groupSlug: string,
  wsIds: readonly string[],
): Promise<{ workspaceId: string; write: boolean }[]> {
  if (wsIds.length === 0) return [];
  return (await db.execute(
    sql`select workspace_id::text as "workspaceId", write
          from "public"."mantle_connector_rows"(${ownerId}::uuid, ${groupSlug},
                                                 ${wsArraySql(wsIds)})`,
  )) as unknown as { workspaceId: string; write: boolean }[];
}

/**
 * Whether the connector `groupSlug` reaches anyone beyond the Admin
 * workspace: a live workspace other than Admin holds it (W5b2; before, a
 * connector below admin level). Such a connector's new or returning remote
 * tools arrive disabled, a moved connector's write tools are disabled, and
 * an agent turning one of its tools on waits for the owner.
 */
export async function connectorOpensBeyondAdmin(
  ownerId: string,
  groupSlug: string,
): Promise<boolean> {
  return (await connectorBeyondAdmin(ownerId, groupSlug)) !== null;
}

/** How the live workspaces other than Admin hold the connector `groupSlug`:
 *  null when none does, else whether one of them has its Write on. */
async function connectorBeyondAdmin(
  ownerId: string,
  groupSlug: string,
): Promise<{ write: boolean } | null> {
  // By its definer (mantle_connector_beyond_admin, 0293; A6b: on the system
  // pool before, 'workspace-resources').
  const [row] = (await db.execute(
    sql`select "public"."mantle_connector_beyond_admin"(${ownerId}::uuid, ${groupSlug}) as write`,
  )) as unknown as { write: boolean | null }[];
  return row && row.write !== null ? { write: row.write === true } : null;
}

/**
 * Why an APP's run may not use the connector `groupSlug`, or null (plan R2):
 * every workspace that holds the app (its read_ws) must hold the connector,
 * and a write needs the connector's Write on in every one of them. An app
 * no workspace holds uses no connector. Read as the system: the rule is in
 * the query.
 */
export async function appConnectorRefused(
  ownerId: string,
  appId: string,
  groupSlug: string,
  write: boolean,
): Promise<string | null> {
  // The workspaces holding the app, by its definer (mantle_app_holders,
  // 0293: an app the scope reads; A6b: on the system pool before).
  const [app] = (await db.execute(
    sql`select "public"."mantle_app_holders"(${ownerId}::uuid, ${appId}::uuid)::text[] as holders`,
  )) as unknown as { holders: string[] | null }[];
  const holders = [...new Set(app?.holders ?? [])];
  if (holders.length === 0) {
    return 'This app is in no workspace, so connector tools do not run from it.';
  }
  const rows = await connectorResources(ownerId, groupSlug, holders);
  const held = new Map(rows.map((r) => [r.workspaceId, r.write]));
  if (!holders.every((w) => held.has(w))) {
    return 'This connector is not a resource of every workspace that holds this app, so its tools do not run from it.';
  }
  if (write && !holders.every((w) => held.get(w) === true)) {
    return 'This connector tool can change data: it needs the connector’s Write switched on in every workspace that holds this app.';
  }
  return null;
}

/** Why a login's connector call is refused (`groupSlug`, `write`), or null. */
export type LoginConnectorRule = (groupSlug: string, write: boolean) => string | null;

/**
 * The connector rule of ONE login (W4b fix round 1, M3; fix round 2; W5b2),
 * loaded once: the connector must be a resource of one of the login's
 * workspaces, and a tool not marked read-only needs that resource's Write
 * on in a workspace where the login is a Moderator. A login in no workspace
 * gets no connector at all, and so does every login of a brain with no
 * workspaces (the migration skipped it): the connector's level no longer
 * decides (W5b2), so nothing below the owner reaches a connector there.
 *
 * The ONE rule behind a login's MCP listing (listLoginConnectorTools), its
 * MCP call (callLoginTool), its app runs (connectorToolVerdict) and the
 * dispatch of a call on its surface (dispatch.ts), so they never disagree.
 * Read as the system: the rule is in the query.
 */
export async function loginConnectorRule(
  ownerId: string,
  loginId: string,
): Promise<LoginConnectorRule> {
  // The login's live workspaces and the connectors each holds, by their
  // definer (mantle_login_connector_rows, 0293: in a scope, the scope's own
  // login only; A6b: two reads on the system pool before).
  const rows = (await db.execute(
    sql`select workspace_id::text as "workspaceId", moderator, slug, write
          from "public"."mantle_login_connector_rows"(${ownerId}::uuid, ${loginId}::uuid)`,
  )) as unknown as {
    workspaceId: string;
    moderator: boolean;
    slug: string | null;
    write: boolean | null;
  }[];
  const mine = [...new Map(rows.map((r) => [r.workspaceId, r])).values()];
  if (mine.length === 0) {
    return () =>
      'You are not a user of any workspace on this brain, so connector tools do not run for you.';
  }
  // Every connector resource of the login's workspaces (live, unarchived
  // ones of this brain: `mine` holds no other).
  const held = rows.flatMap((r) =>
    r.slug === null ? [] : [{ workspaceId: r.workspaceId, slug: r.slug, write: r.write === true }],
  );
  const moderated = new Set(mine.filter((r) => r.moderator).map((r) => r.workspaceId));
  return (groupSlug, write) => {
    const rows = held.filter((r) => r.slug === groupSlug);
    if (rows.length === 0) {
      return 'This connector is not a resource of any of your workspaces, so its tools do not run for you.';
    }
    if (!write) return null;
    if (!rows.some((r) => r.write && moderated.has(r.workspaceId))) {
      return 'This connector tool can change data: it needs the connector’s Write switched on in a workspace where you are a Moderator.';
    }
    return null;
  };
}

/** A login's connector call of one tool, by loginConnectorRule: why it is
 *  refused, or null. */
export async function loginConnectorRefused(
  ownerId: string,
  loginId: string,
  groupSlug: string,
  write: boolean,
): Promise<string | null> {
  return (await loginConnectorRule(ownerId, loginId))(groupSlug, write);
}

/** Why a shared link never runs a connector tool (W5b2): a link holds no
 *  workspace, and connectors are workspace resources. */
export const LINK_NO_CONNECTORS =
  'A shared link holds no workspace, so it uses no connector tools (connectors are attached to workspaces).';

/**
 * The ONE rule for a CONNECTOR tool (an mcp tool) in an app run below admin
 * (team apps Phase 2; workspaces plan section 6 and R2, W5b2): the
 * workspaces that hold the connector decide who may use it, and the admin's
 * read-only mark decides read or write. It replaces External access for
 * connector tools; a single http tool keeps External access
 * (externalToolVerdict). The connector's level decides nothing here (it
 * only says which agents may hold the group, until W7).
 *
 *  - the connector is enabled and bound (dispatchMcp refuses otherwise);
 *  - a tool that needs a confirmation is refused (nobody is there);
 *  - marked read-only (the admin's confirm, on the handler they looked at)
 *    = a read; unmarked = a WRITE, which an app run by a member or a client
 *    may make too (Jason's decision 1), where the workspace rule lets it.
 *    The brokers log every write call with its input;
 *  - who: with the runner's login known (a member's or a client's run), the
 *    login's workspace rule (loginConnectorRule), the same as the login's
 *    own MCP, so an app is no way around it. A run with no login (a
 *    member-built app an admin opens, the author warnings: rulesOnly) needs
 *    a workspace other than Admin to hold the connector, with Write on in
 *    one of them for a write (until 0286 a member's such run needed the
 *    built-in Team workspace to). A client's run always names its login
 *    (W5a audit W2). A contact link holds no workspace, so it uses no
 *    connector (LINK_NO_CONNECTORS);
 *  - which app: with `check.appId`, every workspace that holds the app
 *    must hold the connector too (appConnectorRefused).
 */
/** How an outside tool is checked. `rulesOnly`: no run, the author warnings
 *  (appToolWarnings) ask what the rules allow, with no runner login. Never
 *  set it for a run: a client run without a login is refused. `appId`: the
 *  app the run is for, whose holders must hold a connector it calls. */
export type OutsideToolCheck = { rulesOnly?: true; appId?: string };

export async function connectorToolVerdict(
  ownerId: string,
  tool: Tool,
  slug: string,
  runner: ExternalAccessRunner,
  loginId?: string,
  check?: OutsideToolCheck,
): Promise<OutsideToolVerdict> {
  const who =
    runner === 'member' ? 'a team app' : runner === 'client' ? 'a client app' : 'a shared link';
  const refuse = (reason: string): OutsideToolVerdict => ({ ok: false, status: 403, reason });
  if (runner === 'contact') return refuse(`The tool '${slug}' can't run: ${LINK_NO_CONNECTORS}`);
  if (tool.requiresConfirm) {
    return refuse(
      `The tool '${slug}' needs an admin's confirmation on every call, so ${who} can't use it.`,
    );
  }
  const group = await connectorGroupOf(ownerId, tool);
  if (!group?.usable) {
    return refuse(
      `The connector of the tool '${slug}' is off or not set up, so ${who} can't use it.`,
    );
  }
  const policy = connectorToolPolicy(tool);
  if (policy.fields.mark === 'stale') {
    return refuse(
      `The tool '${slug}' changed after an admin marked it read-only, so ${who} can't use it until an admin marks it again.`,
    );
  }
  const write = policy.effect === 'write';
  // A client always runs as a known login (W5a audit W2): with none, there
  // is no rule to hold it to, so refuse rather than fall through. Only the
  // author warnings ask without a run (rulesOnly).
  if (runner === 'client' && !loginId && !check?.rulesOnly) {
    return refuse(
      `The tool '${slug}' can't run: ${who} needs the signed-in client to use a connector.`,
    );
  }
  if (loginId) {
    const refused = await loginConnectorRefused(ownerId, loginId, group.slug, write);
    if (refused) return refuse(`The tool '${slug}' can't run: ${refused}`);
  } else {
    const held = await connectorBeyondAdmin(ownerId, group.slug);
    if (!held) {
      return refuse(
        `The tool '${slug}' belongs to a connector no workspace other than Admin holds, so ${who} can't use it.`,
      );
    }
    if (write && !held.write) {
      return refuse(
        `The tool '${slug}' belongs to a connector no workspace other than Admin holds with Write on, so ${who} can't use it.`,
      );
    }
  }
  if (check?.appId) {
    const refused = await appConnectorRefused(ownerId, check.appId, group.slug, write);
    if (refused) return refuse(`The tool '${slug}' can't run: ${refused}`);
  }
  return { ok: true, tool, write };
}

/**
 * The connector tools a login may use over its own MCP (team apps Phase 2;
 * W5b2): enabled mcp tools of an enabled, bound connector whose call would
 * pass the login's workspace rule (loginConnectorRule), each with whether
 * it carries the admin's read-only mark. A write tool is left out where the
 * login may not write, and a tool that needs a confirmation always is
 * (nobody confirms on a login's MCP). The rule is in the query (as the
 * system: a limited scope's row security may hide the groups).
 */
export async function listLoginConnectorTools(
  ownerId: string,
  loginId: string,
): Promise<{ tool: Tool; readOnly: boolean; groupId: string; groupName: string }[]> {
  const rows = await connectorBindingSystemWork(() =>
    db
      .select({
        tool: tools,
        groupId: toolGroups.id,
        groupName: toolGroups.name,
        groupSlug: toolGroups.slug,
      })
      .from(tools)
      .innerJoin(
        toolGroups,
        and(
          eq(toolGroups.ownerId, tools.ownerId),
          sql`${toolGroups.slug} = ${tools.handler}->>'group'`,
        ),
      )
      .where(
        and(
          eq(tools.ownerId, ownerId),
          eq(tools.enabled, true),
          eq(tools.requiresConfirm, false),
          sql`${tools.handler}->>'kind' = 'mcp'`,
          eq(toolGroups.enabled, true),
          sql`${toolGroups.integration} ? 'mcp'`,
        ),
      ),
  );
  const rule = await loginConnectorRule(ownerId, loginId);
  return rows.flatMap((r) => {
    // A voided mark is refused below the owner (connectorToolPolicy).
    const policy = connectorToolPolicy(r.tool);
    if (policy.fields.mark === 'stale') return [];
    if (rule(r.groupSlug, policy.effect === 'write') !== null) return [];
    return [
      {
        tool: r.tool,
        readOnly: policy.effect === 'read',
        groupId: r.groupId,
        groupName: r.groupName,
      },
    ];
  });
}

/** An outside tool's verdict by its kind: a connector tool by the
 *  workspaces that hold its connector and its read-only mark, any other by
 *  External access
 *  (which only a read-only tool gets, so it never writes). */
export async function outsideToolVerdict(
  ownerId: string,
  tool: Tool,
  slug: string,
  runner: ExternalAccessRunner,
  loginId?: string,
  check?: OutsideToolCheck,
): Promise<OutsideToolVerdict> {
  if ((tool.handler as ToolHandler).kind === 'mcp') {
    return connectorToolVerdict(ownerId, tool, slug, runner, loginId, check);
  }
  const v = externalToolVerdict(tool, slug, runner);
  return v.ok ? { ...v, write: false } : v;
}

/** The longest input a write call's log row keeps. */
export const OUTSIDE_WRITE_LOG_INPUT_MAX = 2048;

/** What an app's tool-call log row adds for an allowed outside call: its
 *  kind, and for a write, that it writes and its input (capped). The input
 *  can hold what the runner typed: the log is for admins only. A team
 *  app's Table write (`tableArg`: the argument it names its Table in,
 *  app-tool-level.ts appRunTableWrite) logs that it writes, the Table and
 *  how many rows the call sends (a commit: that it commits), never the
 *  cells (task 2178377a fix round 1, LOW-1). */
export function outsideCallLogDetail(
  verdict: { tool: Tool; write?: boolean },
  input: unknown,
  tableArg?: string | null,
): Record<string, unknown> {
  const handler = verdict.tool?.handler as ToolHandler | undefined;
  const kind = handler?.kind;
  if (kind === 'builtin' && tableArg) {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const table = args[tableArg];
    const tableId = typeof table === 'string' ? table.trim().slice(0, 64) : null;
    if (handler?.kind === 'builtin' && handler.ref === 'table_commit') {
      return { write: true, table_id: tableId, commit: true };
    }
    return {
      write: true,
      table_id: tableId,
      rows: Array.isArray(args.rows) ? args.rows.length : 1,
    };
  }
  if (!kind || kind === 'builtin') return {};
  if (!verdict.write) return { handler: kind };
  let text: string;
  try {
    text = JSON.stringify(input ?? {});
  } catch {
    text = '[input not serialisable]';
  }
  return { handler: kind, write: true, input: text.slice(0, OUTSIDE_WRITE_LOG_INPUT_MAX) };
}

/**
 * May a CONTACT on a contact-share link call `slug` from the shared app that
 * declares `declared`? Only an outside tool that is not a connector's, with
 * External access. No built-in ever runs on a link (a link has no login,
 * and a brain read tool would reach the owner's content), and no connector
 * tool (W5b2: a link holds no workspace, LINK_NO_CONNECTORS). The /s broker
 * has already refused an open link (no contact) and checked the contact's
 * code gate.
 */
export async function contactAppToolVerdict(
  ownerId: string,
  declared: readonly string[],
  slug: string,
): Promise<
  { ok: true; tool: Tool; write: boolean } | { ok: false; status: 403 | 404; reason: string }
> {
  if (!declared.includes(slug)) {
    return {
      ok: false,
      status: 403,
      reason: `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools.`,
    };
  }
  const tool = await resolveTool(ownerId, slug);
  if (!tool) return { ok: false, status: 404, reason: `tool '${slug}' not found` };
  if (tool.handler.kind === 'builtin') {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' is built in, and a shared link runs no built-in tools (only an outside tool with External access).`,
    };
  }
  return outsideToolVerdict(ownerId, tool, slug, 'contact');
}

/** The switch as the wire shows it (`ToolDTO.externalAccess`). */
export function externalAccessSummary(
  tool: Pick<
    Tool,
    'slug' | 'handler' | 'requiresConfirm' | 'externalAccess' | 'description' | 'inputSchema'
  >,
): ToolExternalAccessDTO | null {
  const t = tool.externalAccess;
  if (!t) return null;
  return { on: externalAccessActive(tool), confirmedReadOnlyAt: t.confirmedReadOnlyAt, by: t.by };
}

/** Who sets the switch. `web` is an admin login on the owner API; `mcp` and
 *  `dev-tools` are the owner's own MCP client and tool console. */
export type ExternalAccessActor = ToolExternalAccess['by'];

/** Who switches it off: an admin path, or an in-brain agent (which may only
 *  close a tool, never open one). */
export type ExternalAccessOffActor = ExternalAccessActor | { via: 'agent' };

export type SetExternalAccessResult =
  { ok: true; tool: Tool } | { ok: false; status: 400 | 404; error: string };

/** Whether a stored input schema lists its inputs: a `properties` object,
 *  or a closed schema that takes none. The open stand-in the sync stores
 *  for a schema too large to keep lists nothing. */
function hasListedInputs(schema: unknown): boolean {
  const s = (schema && typeof schema === 'object' ? schema : {}) as {
    properties?: unknown;
    additionalProperties?: unknown;
  };
  if (s.properties && typeof s.properties === 'object') return true;
  return !(s.additionalProperties === true || typeof s.additionalProperties === 'object');
}

/**
 * Switch "External access" on or off for the tool `toolId`. Switching on
 * needs `readOnlyConfirmed` (the admin confirms the tool only reads; the
 * brain cannot check it) and an eligible tool. Off always works. Both are
 * written to the audit log with the actor. The caller has checked that the
 * actor is an admin.
 */
export async function setToolExternalAccess(
  ownerId: string,
  toolId: string,
  opts: { allow: boolean; readOnlyConfirmed?: boolean; by: ExternalAccessOffActor },
): Promise<SetExternalAccessResult> {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.id, toolId)))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: 'tool not found' };

  let value: ToolExternalAccess | null = null;
  if (opts.allow) {
    // Belt and braces: the callers refuse an agent first.
    if (opts.by.via === 'agent') {
      return {
        ok: false,
        status: 400,
        error:
          'Only an admin can switch "External access" on (Settings → Tools, or the owner\'s MCP client).',
      };
    }
    const by: ExternalAccessActor = opts.by;
    const why = externalAccessIneligible(row);
    if (why) return { ok: false, status: 400, error: why };
    // A connector tool whose schema the sync stored open, with no inputs
    // listed (the remote schema was too large to keep), cannot be marked:
    // nobody saw its inputs, and below the owner a marked tool takes only
    // the inputs it lists (audit B2).
    if ((row.handler as ToolHandler).kind === 'mcp' && !hasListedInputs(row.inputSchema)) {
      return {
        ok: false,
        status: 400,
        error: `'${row.slug}' was synced without its list of inputs (its schema is too large to keep), so it can't be marked read-only. Leave it to admins, or ask the connector's maker for a smaller schema.`,
      };
    }
    if (opts.readOnlyConfirmed !== true) {
      return {
        ok: false,
        status: 400,
        error: `Confirm that '${row.slug}' only reads data (readOnlyConfirmed: true). The brain cannot check what an outside tool does, and everyone an app that declares it is shared with (members, clients, contacts on a contact link) can call it, by hand too, with ANY input, not only what the app's screens send (for a tool that takes free SQL: anything the connector can read).`,
      };
    }
    value = {
      confirmedReadOnlyAt: new Date().toISOString(),
      by,
      handlerSig: externalAccessToolSig(row),
    };
  }
  const [updated] = await db
    .update(tools)
    .set({ externalAccess: value, updatedAt: new Date() })
    .where(and(eq(tools.ownerId, ownerId), eq(tools.id, toolId)))
    .returning();
  if (!updated) return { ok: false, status: 404, error: 'tool not found' };
  // The audit trail: who opened or closed which tool. Only admin paths call
  // this (no viewer scope), so `db` is the admin pool. Best-effort: it never
  // fails the switch.
  void db
    .insert(auditLog)
    .values({
      actorId: 'actorId' in opts.by ? (opts.by.actorId ?? null) : null,
      actorEmail:
        'actorEmail' in opts.by && opts.by.actorEmail
          ? opts.by.actorEmail
          : `owner (${opts.by.via})`,
      action: opts.allow ? 'tool.external_access.on' : 'tool.external_access.off',
      detail: { toolId, slug: row.slug, kind: (row.handler as ToolHandler).kind, via: opts.by.via },
    })
    .catch((err: unknown) => {
      console.error('[audit] failed to record tool.external_access:', err);
    });
  return { ok: true, tool: updated };
}

/**
 * A connector moved to another server or credential: its tools now reach
 * something the admin never confirmed. Every read-only mark on them is
 * VOIDED (kept, never a handler's signature), so a marked tool is refused
 * below the owner until an admin marks it again, never turned into a write
 * (M2 audit, low 5); and on a connector a workspace other than Admin
 * holds (connectorOpensBeyondAdmin) its unmarked (write) tools are disabled
 * until an admin enables them again. Called by the connector binding
 * update.
 */
/** How many of a connector's tools carry a read-only mark (live or void). */
export async function connectorMarkCount(ownerId: string, groupSlug: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tools)
    .where(
      and(
        eq(tools.ownerId, ownerId),
        sql`${tools.handler}->>'kind' = 'mcp'`,
        sql`${tools.handler}->>'group' = ${groupSlug}`,
        sql`${tools.externalAccess} is not null`,
      ),
    );
  return row?.n ?? 0;
}

export async function clearConnectorExternalAccess(
  ownerId: string,
  groupSlug: string,
): Promise<void> {
  const ofConnector = and(
    eq(tools.ownerId, ownerId),
    sql`${tools.handler}->>'kind' = 'mcp'`,
    sql`${tools.handler}->>'group' = ${groupSlug}`,
  );
  await db
    .update(tools)
    .set({
      externalAccess: sql`jsonb_set(${tools.externalAccess}, '{handlerSig}', to_jsonb(${VOIDED_MARK_SIG}::text))`,
    })
    .where(and(ofConnector, sql`${tools.externalAccess} is not null`));
  if (await connectorOpensBeyondAdmin(ownerId, groupSlug)) {
    await db
      .update(tools)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(ofConnector, sql`${tools.externalAccess} is null`));
  }
}

/**
 * A vault key was replaced (rotated, or saved again under the same service
 * and label): every connector that signs in with it (`secretRef`) now
 * reaches the remote server as whoever the new key belongs to, which the
 * admin never looked at (access matrix T7). The same as a move to another
 * credential: its marks are voided and, beyond Admin, its write tools are
 * disabled (`clearConnectorExternalAccess`). Gives back the connectors it
 * touched, so the caller can drop their cached connections.
 */
export async function voidConnectorMarksForKey(
  ownerId: string,
  service: string,
  label: string,
): Promise<string[]> {
  const ref = `${service}/${label}`;
  const groups = await db
    .select({ slug: toolGroups.slug })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        sql`${toolGroups.integration}->'mcp'->>'secretRef' = ${ref}`,
      ),
    );
  for (const g of groups) await clearConnectorExternalAccess(ownerId, g.slug);
  return groups.map((g) => g.slug);
}
