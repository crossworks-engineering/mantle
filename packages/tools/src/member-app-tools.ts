/**
 * Which tools a MEMBER's run of an app may call (member logins Phase 4b, plan
 * v3.1 section 4a). `dispatchTool` checks none of this (no group, no enabled
 * group, no requiresConfirm), so the member tool broker asks here first, at
 * dispatch time, every call. `app_tools_set` asks the same question to warn
 * the author, so the warning and the refusal can never disagree.
 *
 * A tool is allowed only when ALL hold:
 *   1. the app declares it (manifest.toolSlugs);
 *   2. neither its slug nor its builtin handler is on MEMBER_APP_REFUSED_SLUGS
 *      (checked on both: a tool row can carry any slug over a builtin ref);
 *   3. it exists and is enabled, has a BUILTIN handler (no http, shell,
 *      recipe or mcp: those reach URLs, the shell or composed tools under the
 *      brain) and does not require confirmation (nobody is there to confirm);
 *   4. that builtin does not spend (`spends`: it starts paid model work on a
 *      call) and is marked read-only (`readOnly`, the default-deny flag the
 *      read-only turn uses): an app loop has no model in between, so a
 *      writing or spending builtin an admin put in a team-level group for
 *      chat must not become callable 60 times a minute (audit 2026-09-27;
 *      `spends` since audit F17, as a read can spend too);
 *   5. an ENABLED tool group at team level or lower holds it.
 * The caller then dispatches inside `withViewer('team', …)` on a team surface
 * that carries the login, so row security still decides what the tool reads.
 *
 * These are the rules of a TEAM-level app, for every runner: the brokers pick
 * the rules by the lower of the runner's level and the app's (app-tool-level.ts,
 * client tier audit L1), so a member's run of a client-level app gets the
 * client rules instead, and an admin's run of a team app gets these.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, toolGroups, type Tool } from '@mantle/db';
import { resolveTool } from './resolve';

/** The group levels a member's app may draw tools from. */
const MEMBER_GROUP_LEVELS = ['team', 'client', 'public'];

/**
 * Tools a member's app may never call, even from a team-level group:
 * - my_items_list / my_item_open read the runner's PRIVATE items; an app
 *   could copy them into its database, which every member and admin reads.
 *   The same reasoning, one level up, is why no app tool reads above the
 *   app's own level (app-tool-level.ts): whatever a tool returns can end up
 *   in the app's shared database, where everyone who runs the app reads it.
 * - summarize_text and extract_from_image start LLM work (a chat and a
 *   vision model), and search_chunks does when the decider's passage scoring
 *   is on (cost-safety: a member app starts none). Every builtin flagged
 *   `spends` is refused by rule 4 as well; these stay listed so the refusal
 *   holds before any lookup.
 * - team_request_create files an admin task from a chat turn; it needs the
 *   turn's message, and an app could file them in a loop.
 * - read_result opens a spilled result of an agent turn by handle.
 */
export const MEMBER_APP_REFUSED_SLUGS: readonly string[] = [
  'my_items_list',
  'my_item_open',
  'summarize_text',
  'extract_from_image',
  'search_chunks',
  'team_request_create',
  'read_result',
];

export type MemberAppToolVerdict =
  { ok: true; tool: Tool } | { ok: false; status: 403 | 404; reason: string };

/** Whether an enabled tool group at team level or lower holds `slug`. */
async function inTeamLevelGroup(ownerId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ slug: toolGroups.slug })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        eq(toolGroups.enabled, true),
        inArray(toolGroups.audience, MEMBER_GROUP_LEVELS),
        sql`${slug} = any(${toolGroups.toolSlugs})`,
      ),
    )
    .limit(1);
  return !!row;
}

/** May a member's run of an app that declares `declared` call `slug`? */
export async function memberAppToolVerdict(
  ownerId: string,
  declared: readonly string[],
  slug: string,
): Promise<MemberAppToolVerdict> {
  if (!declared.includes(slug)) {
    return {
      ok: false,
      status: 403,
      reason: `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools.`,
    };
  }
  if (MEMBER_APP_REFUSED_SLUGS.includes(slug)) {
    return { ok: false, status: 403, reason: `The tool '${slug}' is not available in team apps.` };
  }
  const tool = await resolveTool(ownerId, slug);
  if (!tool) return { ok: false, status: 404, reason: `tool '${slug}' not found` };
  if (tool.handler.kind !== 'builtin') {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' can't be used from a team app (only built-in tools are).`,
    };
  }
  if (MEMBER_APP_REFUSED_SLUGS.includes(tool.handler.ref)) {
    return { ok: false, status: 403, reason: `The tool '${slug}' is not available in team apps.` };
  }
  // Lazy: the registry imports every builtin, app_tools_set among them.
  const { isBuiltinReadOnly, isBuiltinSpending } = await import('./registry');
  if (isBuiltinSpending(tool.handler.ref)) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' starts paid model work on every call, so a team app can't use it.`,
    };
  }
  if (!isBuiltinReadOnly(tool.handler.ref)) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' changes data or reaches outside the brain, so a team app can't use it (only read-only built-in tools are).`,
    };
  }
  if (tool.requiresConfirm) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' needs an admin's confirmation, so a team app can't use it.`,
    };
  }
  if (!(await inTeamLevelGroup(ownerId, slug))) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' is not in a team-level tool group, so team members can't use it.`,
    };
  }
  return { ok: true, tool };
}
