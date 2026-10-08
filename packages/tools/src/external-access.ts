/**
 * "External access": the admin's switch on ONE outside tool (docs/
 * member-logins.md, "External access: outside tools in shared apps").
 * Decided 2026-10-01 as "Team apps may use"; widened and renamed 2026-10-02:
 * whoever an app is shared with may need the site service it calls.
 *
 * Below admin, an app's run may call only read-only built-in tools (member-
 * app-tools.ts, client-app-tools.ts), and a share link none: an app loop has
 * no model in between, and the brain cannot judge what an outside tool does.
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
 * CONNECTOR tools (mcp) follow another rule since team apps Phase 2
 * (connectorToolVerdict below): the connector's level decides who may use
 * them, and the confirm stored here is their READ-ONLY MARK (marked = a
 * read, unmarked = a write). The switch's eligibility and signature rules
 * hold for the mark as they did for the switch.
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
  asViewerLevel,
  auditLog,
  db,
  levelCovers,
  toolGroups,
  tools,
  type Tool,
  type ToolHandler,
  type ToolExternalAccess,
  type ViewerLevel,
} from '@mantle/db';
import type { ToolExternalAccessDTO } from '@mantle/client-types';
import { resolveTool } from './resolve';

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

// ── Connector tools: the connector's level decides (team apps Phase 2) ──────

/** The level a runner's app call runs at, for a connector's level: a
 *  member's team rules, a client app's client rules, a contact link's
 *  public scope. */
const RUNNER_LEVEL: Record<ExternalAccessRunner, ViewerLevel> = {
  member: 'team',
  client: 'client',
  contact: 'public',
};

/** An outside tool's verdict, and whether the call writes: a connector tool
 *  without the admin's read-only mark is a write tool. */
export type OutsideToolVerdict =
  { ok: true; tool: Tool; write: boolean } | { ok: false; status: 403; reason: string };

/** The connector group of a connector tool (its handler names it: the one
 *  link a sync, a dispatch and the switch clearing all use), or null. */
export async function connectorGroupOf(
  ownerId: string,
  tool: Pick<Tool, 'handler'>,
): Promise<{ id: string; slug: string; level: ViewerLevel; usable: boolean } | null> {
  const h = tool.handler as ToolHandler;
  if (h.kind !== 'mcp') return null;
  // As the system: a client-scope read sees client-level groups only, and
  // the rule is in the code below, not in row security.
  const [g] = await asSystem(() =>
    db
      .select({
        id: toolGroups.id,
        slug: toolGroups.slug,
        audience: toolGroups.audience,
        enabled: toolGroups.enabled,
        integration: toolGroups.integration,
      })
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, h.group)))
      .limit(1),
  );
  if (!g) return null;
  return {
    id: g.id,
    slug: g.slug,
    level: asViewerLevel(g.audience),
    usable: g.enabled === true && !!g.integration?.mcp,
  };
}

/** Whether a runner at `run` may use a connector at `connector` level: the
 *  connector's level must be one the runner's level reads (levelCovers),
 *  as for an item. */
export function connectorLevelAllows(run: ViewerLevel, connector: ViewerLevel): boolean {
  return levelCovers(run, connector);
}

/**
 * The ONE rule for a CONNECTOR tool (an mcp tool) in an app run below admin
 * (team apps Phase 2, Jason 2026-10-08): the connector group's level decides
 * who may use it, the same as the level on an item, and the admin's
 * read-only mark decides read or write. It replaces External access for
 * connector tools; a single http tool keeps External access
 * (externalToolVerdict).
 *
 *  - the connector is enabled and bound (dispatchMcp refuses otherwise);
 *  - its level is one the run's level reads: a member's team rules reach a
 *    team, client or public connector; a client app a client one; a contact
 *    link a public one. A new connector starts at admin: nothing opens by
 *    itself, and no code ever raises a level;
 *  - a tool that needs a confirmation is refused (nobody is there);
 *  - marked read-only (the admin's confirm, on the handler they looked at)
 *    = a read; unmarked = a WRITE, which an app run by a member or a client
 *    may make too (Jason's decision 1). A contact link only reads (Jason,
 *    2026-10-08): an unmarked tool is refused there. The brokers log every
 *    write call with its input. dispatchMcp holds the same level and
 *    public-read rule on every call (connectorCallRefused).
 */
export async function connectorToolVerdict(
  ownerId: string,
  tool: Tool,
  slug: string,
  runner: ExternalAccessRunner,
): Promise<OutsideToolVerdict> {
  const who =
    runner === 'member' ? 'a team app' : runner === 'client' ? 'a client app' : 'a shared link';
  if (tool.requiresConfirm) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' needs an admin's confirmation on every call, so ${who} can't use it.`,
    };
  }
  const group = await connectorGroupOf(ownerId, tool);
  if (!group?.usable) {
    return {
      ok: false,
      status: 403,
      reason: `The connector of the tool '${slug}' is off or not set up, so ${who} can't use it.`,
    };
  }
  const run = RUNNER_LEVEL[runner];
  if (!connectorLevelAllows(run, group.level)) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' belongs to a connector at ${group.level} level, so ${who} can't use it. An admin can set the connector's level (Settings → Tool groups).`,
    };
  }
  const mark = connectorMarkState(tool);
  if (mark === 'stale') {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' changed after an admin marked it read-only, so ${who} can't use it until an admin marks it again.`,
    };
  }
  const write = mark === 'write';
  // Contacts read only (Jason, 2026-10-08): writes through a connector stay
  // with signed-in members and clients, whatever the connector's level.
  if (write && runner === 'contact') {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' can change data, and a shared link uses only connector tools an admin marked read-only.`,
    };
  }
  return { ok: true, tool, write };
}

/**
 * The connector tools a login at `level` may use over its own MCP (team
 * apps Phase 2): enabled mcp tools of an enabled, bound connector whose
 * level `level` reads, each with whether it carries the admin's read-only
 * mark. A tool that needs a confirmation is left out (nobody confirms on a
 * login's MCP). The rule is in the query (as the system: a client scope's
 * row security would hide the groups, and the level is checked here).
 */
export async function listLoginConnectorTools(
  ownerId: string,
  level: ViewerLevel,
): Promise<
  { tool: Tool; readOnly: boolean; groupId: string; groupName: string; groupLevel: ViewerLevel }[]
> {
  const rows = await asSystem(() =>
    db
      .select({
        tool: tools,
        groupId: toolGroups.id,
        groupName: toolGroups.name,
        groupLevel: toolGroups.audience,
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
  return rows.flatMap((r) => {
    const groupLevel = asViewerLevel(r.groupLevel);
    if (!connectorLevelAllows(level, groupLevel)) return [];
    // A voided mark is refused below the owner (connectorMarkState).
    if (connectorMarkState(r.tool) === 'stale') return [];
    return [
      {
        tool: r.tool,
        readOnly: externalAccessActive(r.tool),
        groupId: r.groupId,
        groupName: r.groupName,
        groupLevel,
      },
    ];
  });
}

/** An outside tool's verdict by its kind: a connector tool by its
 *  connector's level and read-only mark, any other by External access
 *  (which only a read-only tool gets, so it never writes). */
export async function outsideToolVerdict(
  ownerId: string,
  tool: Tool,
  slug: string,
  runner: ExternalAccessRunner,
): Promise<OutsideToolVerdict> {
  if ((tool.handler as ToolHandler).kind === 'mcp') {
    return connectorToolVerdict(ownerId, tool, slug, runner);
  }
  const v = externalToolVerdict(tool, slug, runner);
  return v.ok ? { ...v, write: false } : v;
}

/** The longest input a write call's log row keeps. */
export const OUTSIDE_WRITE_LOG_INPUT_MAX = 2048;

/** What an app's tool-call log row adds for an allowed outside call: its
 *  kind, and for a write, that it writes and its input (capped). The input
 *  can hold what the runner typed: the log is for admins only. */
export function outsideCallLogDetail(
  verdict: { tool: Tool; write?: boolean },
  input: unknown,
): Record<string, unknown> {
  const kind = (verdict.tool?.handler as ToolHandler | undefined)?.kind;
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
 * declares `declared`? Only an outside tool: a connector tool at public
 * level, or another outside tool with External access. No built-in ever
 * runs on a link (a link has no login, and a brain read tool would reach
 * the owner's content). The /s broker has already refused an open link (no
 * contact) and checked the contact's code gate.
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
      reason: `The tool '${slug}' is built in, and a shared link runs no built-in tools (only outside tools: a connector's at public level, or one with External access).`,
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
 * (M2 audit, low 5); and on a connector below admin its unmarked (write)
 * tools are disabled until an admin enables them again. Called by the
 * connector binding update.
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
  const [group] = await db
    .select({ audience: toolGroups.audience })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (group && group.audience !== 'admin') {
    await db
      .update(tools)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(ofConnector, sql`${tools.externalAccess} is null`));
  }
}
