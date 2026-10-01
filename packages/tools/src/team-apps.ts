/**
 * "Team apps may use": the admin's switch on ONE outside tool (docs/
 * member-logins.md, "Outside tools in team apps"; decided 2026-10-01).
 *
 * A member's run of a team app may call only read-only built-in tools
 * (member-app-tools.ts): an app loop has no model in between, and the brain
 * cannot judge what an outside tool does. Every site adds its own connectors
 * (an MCP server, an http API), so the way through is data on the tool row,
 * set by an admin who confirms the tool only reads:
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
 * The row stores WHEN the admin confirmed, WHO, and a signature of the
 * handler they looked at. The switch counts only while that signature equals
 * the current handler's, so any change to the handler voids it, whoever made
 * it (an edit, a connector sync, SQL by hand). `updateTool` also clears it on
 * such a change, and a connector moved to another server clears it on every
 * tool of that connector, so the UI shows it off. Deleting the tool deletes
 * the row and the switch with it.
 *
 * The member broker still checks everything else every call (declared by the
 * app, an ENABLED team-level group, no confirmation), and logs every call,
 * allowed or refused, with the member. Client-level apps never get an outside
 * tool (client-app-tools.ts is untouched), and public share links run none.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  db,
    tools,
  type Tool,
  type ToolHandler,
  type ToolTeamApps,
} from '@mantle/db';
import type { ToolTeamAppsDTO } from '@mantle/client-types';

/** The handler kinds an admin may open to team apps. */
export const TEAM_APPS_KINDS: readonly ToolHandler['kind'][] = ['mcp', 'http'];

/** http methods that write by name: never open to team apps. */
const WRITE_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

/** JSON with sorted keys, so the same handler always hashes the same. */
function canonical(v: unknown): string {
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
export function teamAppsHandlerSig(handler: ToolHandler): string {
  let h: Record<string, unknown> = { ...(handler as Record<string, unknown>) };
  if (handler.kind === 'mcp') {
    delete h.vanishedAt;
  } else if (handler.kind === 'http' && handler.openapi) {
    const { vanishedAt: _v, editedAt: _e, ...openapi } = handler.openapi;
    h = { ...h, openapi };
  }
  return createHash('sha256').update(canonical(h)).digest('hex');
}

/** Why `tool` can never be opened to team apps as it stands, else null. */
export function teamAppsIneligible(
  tool: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm'>,
): string | null {
  const h = tool.handler as ToolHandler;
  if (h.kind === 'builtin') {
    return `The tool '${tool.slug}' is built in: team apps may use it when it is read-only and in an enabled team-level tool group, with no switch.`;
  }
  if (h.kind === 'shell') {
    return `The tool '${tool.slug}' is a shell tool, and a shell tool can never be opened to team apps.`;
  }
  if (h.kind === 'recipe') {
    return `The tool '${tool.slug}' is a recipe, and a recipe can never be opened to team apps (its steps can call tools that write).`;
  }
  if (!TEAM_APPS_KINDS.includes(h.kind)) {
    return `The tool '${tool.slug}' can't be opened to team apps.`;
  }
  if (h.kind === 'http' && WRITE_METHODS.has(h.method ?? 'GET')) {
    return `The tool '${tool.slug}' sends ${h.method}, which changes data, so it can't be opened to team apps.`;
  }
  if (tool.requiresConfirm) {
    return `The tool '${tool.slug}' needs an admin's confirmation on every call, so it can't be opened to team apps (nobody is there to confirm).`;
  }
  return null;
}

/** Whether the admin's switch counts on `tool` right now: set, still on the
 *  handler the admin confirmed, and the tool still eligible. */
export function teamAppsActive(
  tool: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm' | 'teamApps'>,
): boolean {
  const t = tool.teamApps;
  if (!t || typeof t !== 'object' || typeof t.handlerSig !== 'string') return false;
  if (teamAppsIneligible(tool) !== null) return false;
  return t.handlerSig === teamAppsHandlerSig(tool.handler as ToolHandler);
}

/** The switch as the wire shows it (`ToolDTO.teamApps`). */
export function teamAppsSummary(
  tool: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm' | 'teamApps'>,
): ToolTeamAppsDTO | null {
  const t = tool.teamApps;
  if (!t) return null;
  return { on: teamAppsActive(tool), confirmedReadOnlyAt: t.confirmedReadOnlyAt, by: t.by };
}

/** Who sets the switch. `web` is an admin login on the owner API; `mcp` and
 *  `dev-tools` are the owner's own MCP client and tool console. */
export type TeamAppsActor = ToolTeamApps['by'];

/** Who switches it off: an admin path, or an in-brain agent (which may only
 *  close a tool, never open one). */
export type TeamAppsOffActor = TeamAppsActor | { via: 'agent' };

export type SetTeamAppsResult =
  { ok: true; tool: Tool } | { ok: false; status: 400 | 404; error: string };

/**
 * Switch "Team apps may use" on or off for the tool `toolId`. Switching on
 * needs `readOnlyConfirmed` (the admin confirms the tool only reads; the
 * brain cannot check it) and an eligible tool. Off always works. Both are
 * written to the audit log with the actor. The caller has checked that the
 * actor is an admin.
 */
export async function setToolTeamApps(
  ownerId: string,
  toolId: string,
  opts: { allow: boolean; readOnlyConfirmed?: boolean; by: TeamAppsOffActor },
): Promise<SetTeamAppsResult> {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.id, toolId)))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: 'tool not found' };

  let value: ToolTeamApps | null = null;
  if (opts.allow) {
    // Belt and braces: the callers refuse an agent first.
    if (opts.by.via === 'agent') {
      return {
        ok: false,
        status: 400,
        error:
          'Only an admin can switch "Team apps may use" on (Settings → Tools, or the owner\'s MCP client).',
      };
    }
    const by: TeamAppsActor = opts.by;
    const why = teamAppsIneligible(row);
    if (why) return { ok: false, status: 400, error: why };
    if (opts.readOnlyConfirmed !== true) {
      return {
        ok: false,
        status: 400,
        error: `Confirm that '${row.slug}' only reads data (readOnlyConfirmed: true). The brain cannot check what an outside tool does, and every team member can call it, with any input, through any team app that declares it.`,
      };
    }
    value = {
      confirmedReadOnlyAt: new Date().toISOString(),
      by,
      handlerSig: teamAppsHandlerSig(row.handler as ToolHandler),
    };
  }
  const [updated] = await db
    .update(tools)
    .set({ teamApps: value, updatedAt: new Date() })
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
      action: opts.allow ? 'tool.team_apps.on' : 'tool.team_apps.off',
      detail: { toolId, slug: row.slug, kind: (row.handler as ToolHandler).kind, via: opts.by.via },
    })
    .catch((err: unknown) => {
      console.error('[audit] failed to record tool.team_apps:', err);
    });
  return { ok: true, tool: updated };
}

/**
 * A connector moved to another server: its tools now reach something the
 * admin never confirmed, so every switch on them goes off. Called by the
 * connector binding update when its URL changes.
 */
export async function clearConnectorTeamApps(ownerId: string, groupSlug: string): Promise<void> {
  await db
    .update(tools)
    .set({ teamApps: null })
    .where(
      and(
        eq(tools.ownerId, ownerId),
        sql`${tools.teamApps} is not null`,
        sql`${tools.handler}->>'kind' = 'mcp'`,
        sql`${tools.handler}->>'group' = ${groupSlug}`,
      ),
    );
}
