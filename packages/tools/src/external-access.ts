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
 * may come by hand with any input, not only from the app's screens. A tool
 * group's level does not gate an external tool (an mcp tool still needs its
 * connector enabled: dispatchMcp refuses a disabled one).
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
  auditLog,
  db,
  tools,
  type Tool,
  type ToolHandler,
  type ToolExternalAccess,
} from '@mantle/db';
import type { ToolExternalAccessDTO } from '@mantle/client-types';
import { resolveTool } from './resolve';

/** The handler kinds an admin may open to external access. */
export const EXTERNAL_ACCESS_KINDS: readonly ToolHandler['kind'][] = ['mcp', 'http'];

/** http methods that write by name: never opened to external access. */
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
  tool: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm' | 'externalAccess'>,
): boolean {
  const t = tool.externalAccess;
  if (!t || typeof t !== 'object' || typeof t.handlerSig !== 'string') return false;
  if (externalAccessIneligible(tool) !== null) return false;
  return t.handlerSig === externalAccessHandlerSig(tool.handler as ToolHandler);
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

/**
 * May a CONTACT on a contact-share link call `slug` from the shared app that
 * declares `declared`? Only an outside tool with External access: no built-in
 * ever runs on a link (a link has no login, and a brain read tool would reach
 * the owner's content). The /s broker has already refused an open link (no
 * contact) and checked the contact's code gate.
 */
export async function contactAppToolVerdict(
  ownerId: string,
  declared: readonly string[],
  slug: string,
): Promise<{ ok: true; tool: Tool } | { ok: false; status: 403 | 404; reason: string }> {
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
      reason: `The tool '${slug}' is built in, and a shared link runs no built-in tools (only outside tools with External access).`,
    };
  }
  return externalToolVerdict(tool, slug, 'contact');
}

/** The switch as the wire shows it (`ToolDTO.externalAccess`). */
export function externalAccessSummary(
  tool: Pick<Tool, 'slug' | 'handler' | 'requiresConfirm' | 'externalAccess'>,
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
      handlerSig: externalAccessHandlerSig(row.handler as ToolHandler),
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
 * something the admin never confirmed, so every switch on them goes off.
 * Called by the connector binding update.
 */
export async function clearConnectorExternalAccess(
  ownerId: string,
  groupSlug: string,
): Promise<void> {
  await db
    .update(tools)
    .set({ externalAccess: null })
    .where(
      and(
        eq(tools.ownerId, ownerId),
        sql`${tools.externalAccess} is not null`,
        sql`${tools.handler}->>'kind' = 'mcp'`,
        sql`${tools.handler}->>'group' = ${groupSlug}`,
      ),
    );
}
