/**
 * Which tools a CLIENT's run of an app may call (client logins C6,
 * docs/client-logins.md section 10). The twin of member-app-tools.ts, and
 * narrower: `dispatchTool` checks none of this, so the client tool broker
 * asks here first, at dispatch time, every call.
 *
 * A tool is allowed only when ALL hold:
 *   1. the app declares it (manifest.toolSlugs);
 *   2. its slug AND its builtin handler are on CLIENT_APP_TOOL_SLUGS
 *      (checked on both: a tool row can carry any slug over a builtin ref);
 *   3. it exists and is enabled, has a BUILTIN handler and does not require
 *      confirmation (nobody is there to confirm);
 *   4. that builtin does not spend, is marked read-only and is not owner
 *      only;
 *   5. an ENABLED tool group at client level (or public, below it) holds it.
 * The caller then dispatches inside `withViewer('client', …)` on a client
 * surface that names the login, as the client chat does.
 *
 * These are the rules of a CLIENT-level app for EVERY runner (client tier
 * audit L1, app-tool-level.ts): an admin's or a member's run of a client app
 * gets them too, since whatever a tool returns can be stored in the app's
 * database, which every client reads with any SQL.
 *
 * Why the allowlist is so narrow: a brain-wide read tool at client level
 * (search_chunks, page_get, node_read) still returns summaries, chunks and
 * raw documents built from text above client level, which can name team and
 * admin items (the C4 finding). Only the client tools serve the redacted
 * text the portal shows. A group an admin raised a brain-wide tool into does
 * not widen this list.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, toolGroups, type Tool } from '@mantle/db';
import { resolveTool } from './resolve';
import { outsideToolVerdict } from './external-access';

/**
 * The tools a client's app may call: the client chat's tools
 * (CLIENT_TURN_TOOL_SLUGS) without its writes and without `read_result`
 * (it opens a spilled result of a chat turn by handle; an app has none).
 *
 * `my_items_list` and `my_item_open` are left out as well, as for member apps
 * (MEMBER_APP_REFUSED_SLUGS): they read the runner's PRIVATE drafts, and an
 * app could copy them into its database, which members and every other
 * client login read. The same holds for any read above client level, which
 * is why an admin's or a member's run of a client app gets this list too. Neither is marked read-only either, so rule 4 would
 * refuse them anyway. client-app-tools.test.ts pins this list as a subset of
 * the chat's.
 *
 * Adding a tool here is a security decision: it must read at client level and
 * show only what the client portal shows.
 */
export const CLIENT_APP_TOOL_SLUGS: readonly string[] = [
  'client_shared_list',
  'client_shared_search',
  'client_shared_open',
];

/** The group levels a client's app may draw tools from. */
const CLIENT_GROUP_LEVELS = ['client', 'public'];

/** `write`: an outside call that writes (a connector tool without the
 *  read-only mark, team apps Phase 2); the broker logs its input. */
export type ClientAppToolVerdict =
  { ok: true; tool: Tool; write?: boolean } | { ok: false; status: 403 | 404; reason: string };

/** Whether an enabled tool group at client level or lower holds `slug`. */
async function inClientLevelGroup(ownerId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ slug: toolGroups.slug })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        eq(toolGroups.enabled, true),
        inArray(toolGroups.audience, CLIENT_GROUP_LEVELS),
        sql`${slug} = any(${toolGroups.toolSlugs})`,
      ),
    )
    .limit(1);
  return !!row;
}

const notForClients = (slug: string) =>
  `The tool '${slug}' is not available in client apps (only the client tools are).`;

/** May a client's run of an app that declares `declared` call `slug`? */
export async function clientAppToolVerdict(
  ownerId: string,
  declared: readonly string[],
  slug: string,
): Promise<ClientAppToolVerdict> {
  if (!declared.includes(slug)) {
    return {
      ok: false,
      status: 403,
      reason: `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools.`,
    };
  }
  if (!CLIENT_APP_TOOL_SLUGS.includes(slug)) {
    // Off the list, only an outside tool may pass (external-access.ts): a
    // connector tool at CLIENT level, read or write by the admin's read-only
    // mark (team apps Phase 2), or another outside tool with External
    // access. It reads no brain text, so the C4 reason for the narrow list
    // does not apply. A built-in's slug is refused before any lookup, as
    // before; only another slug is looked up, for an outside tool.
    const { getBuiltin } = await import('./registry');
    if (!getBuiltin(slug)) {
      const outside = await resolveTool(ownerId, slug);
      if (outside && outside.handler.kind !== 'builtin') {
        return outsideToolVerdict(ownerId, outside, slug, 'client');
      }
    }
    return { ok: false, status: 403, reason: notForClients(slug) };
  }
  const tool = await resolveTool(ownerId, slug);
  if (!tool) return { ok: false, status: 404, reason: `tool '${slug}' not found` };
  if (tool.handler.kind !== 'builtin' || !CLIENT_APP_TOOL_SLUGS.includes(tool.handler.ref)) {
    return { ok: false, status: 403, reason: notForClients(slug) };
  }
  // Lazy: the registry imports every builtin.
  const { isBuiltinOwnerOnly, isBuiltinReadOnly, isBuiltinSpending } = await import('./registry');
  if (
    isBuiltinSpending(tool.handler.ref) ||
    !isBuiltinReadOnly(tool.handler.ref) ||
    isBuiltinOwnerOnly(tool.handler.ref)
  ) {
    return { ok: false, status: 403, reason: notForClients(slug) };
  }
  if (tool.requiresConfirm) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' needs an admin's confirmation, so a client app can't use it.`,
    };
  }
  if (!(await inClientLevelGroup(ownerId, slug))) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' is not in a client-level tool group, so clients can't use it.`,
    };
  }
  return { ok: true, tool };
}
