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
 *      writing or spending builtin an admin put in a system-wide group for
 *      chat must not become callable 60 times a minute (audit 2026-09-27;
 *      `spends` since audit F17, as a read can spend too);
 *   5. an ENABLED system-wide tool group holds it (not an adminOnly one:
 *      those run only in the Admin workspace; tool-group levels went in
 *      workspaces W7b, plan 5.4).
 * An OUTSIDE tool takes another path after rule 2 (external-access.ts). A
 * CONNECTOR tool (mcp): the workspaces that hold its connector decide (the
 * runner's login's workspaces, and with `check.appId` every workspace that
 * holds the app; W5b2), and the admin's read-only mark makes it a read, its
 * absence a write (team apps Phase 2, Jason 2026-10-08). An http tool: an
 * admin switched on "External access" on it and confirmed it only reads
 * (widened 2026-10-02). Either counts only while the handler is the one the
 * admin confirmed and the tool needs no confirmation. Never for recipe or
 * shell tools.
 * The caller then dispatches inside `withViewer(…)` on a team surface
 * that carries the login, so row security still decides what the tool reads.
 *
 * These are a member's rules for a team or public app. The brokers pick the
 * rules in app-tool-level.ts (client tier audit L1): a client-level app gets
 * the client rules instead, for every runner.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  registerPolicySource,
  toolGroups,
  type GatePolicy,
  type PolicyRef,
  type Tool,
} from '@mantle/db';
import { resolveTool } from './resolve';
import { outsideToolVerdict, type OutsideToolCheck } from './external-access';
import { appToolPolicy } from './runtime-policy';
import { policySlugList } from './tool-policy';

/** Retired builtins with no definition here (the system manifest's
 *  RETIRED_BUILTIN_TOOL_SLUGS: my_items_list, my_item_open,
 *  team_request_create): refused by name, as before, with no policy to
 *  carry the rule. Kept: without them an app that declares one gets a 404
 *  (its row is disabled) instead of this 403, and a brain whose row is not
 *  yet disabled would reach the row rules. */
const TEAM_TOOLS_REFUSED: readonly string[] = [
  'my_items_list',
  'my_item_open',
  'team_request_create',
];

/**
 * Tools a member's app may never call, even from a system-wide group:
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
 *
 * A view of the tool policy table (tool-policy.ts, A5): the builtins whose
 * policy says `memberApp: 'refused'`, plus TEAM_TOOLS_REFUSED.
 */
export const MEMBER_APP_REFUSED_SLUGS: readonly string[] = policySlugList(
  (p) => p.memberApp === 'refused',
  { also: TEAM_TOOLS_REFUSED },
);

/** `write`: an outside call that writes (a connector tool without the
 *  read-only mark, team apps Phase 2); the broker logs its input. */
export type MemberAppToolVerdict =
  { ok: true; tool: Tool; write?: boolean } | { ok: false; status: 403 | 404; reason: string };

/** Whether an enabled system-wide (not adminOnly) tool group holds `slug`. */
async function inSystemWideGroup(ownerId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ slug: toolGroups.slug })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        eq(toolGroups.enabled, true),
        eq(toolGroups.adminOnly, false),
        sql`${slug} = any(${toolGroups.toolSlugs})`,
      ),
    )
    .limit(1);
  return !!row;
}

/** May a member's run of an app that declares `declared` call `slug`?
 *  `check` goes to a connector tool's rule (external-access.ts). */
export async function memberAppToolVerdict(
  ownerId: string,
  declared: readonly string[],
  slug: string,
  loginId?: string,
  check?: OutsideToolCheck,
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
    // An outside tool (external-access.ts): a connector tool by the
    // workspaces that hold its connector, read or write by the admin's
    // read-only mark (team apps Phase 2; W5b2); any other outside tool by
    // External access, the admin's read-only confirmation. Recipe and shell
    // tools, a write method, a tool that needs confirmation and a handler
    // changed since are refused.
    return outsideToolVerdict(ownerId, tool, slug, 'member', loginId, check);
  }
  // Lazy: the registry imports every builtin, app_tools_set among them.
  const { isBuiltinReadOnly, isBuiltinSpending } = await import('./registry');
  // Rules 2 to 4 on the row: the app tool's policy (runtime-policy.ts, arch
  // A3c), the one reading of them.
  const policy = appToolPolicy(
    tool,
    {
      readOnly: isBuiltinReadOnly(tool.handler.ref),
      spends: isBuiltinSpending(tool.handler.ref),
    },
    MEMBER_APP_REFUSED_SLUGS,
  );
  const refused = policy?.fields?.memberApp;
  if (typeof refused === 'string') return { ok: false, status: 403, reason: refused };
  if (!(await inSystemWideGroup(ownerId, slug))) {
    return {
      ok: false,
      status: 403,
      reason: `The tool '${slug}' is only in Admin-only tool groups, so this app can't use it outside the Admin workspace.`,
    };
  }
  return { ok: true, tool };
}

/**
 * An app tool (ref kind `app-tool`, arch A3c fix round 2, M-B): what an
 * app's run calls through a broker (A5). The member-app rule is NOT read
 * again here: the ref carries `verdict`, what memberAppToolVerdict (the
 * live rule, above) said for this call, and the policy's `memberApp` is its
 * answer (null: allowed; else its reason). No verdict: no answer, and the
 * member-app narrower refuses a run at team rules (fail closed). The ref
 * also carries the resolved `row` and, for a built-in, its registry facts
 * (`builtin`: readOnly, spends), for what the call is (read or write).
 *
 * A call the verdict refused before any row was read (not declared, a
 * refused slug, no such tool) is a write here (the strictest), refused by
 * the narrower in the verdict's words. TODO(A5): the brokers answer the
 * verdict's status (403, or 404 for no such tool); the gate's narrowed
 * refusal answers 403.
 */
export function appToolGatePolicy(ref: PolicyRef): GatePolicy | null {
  const verdict = ref.verdict as MemberAppToolVerdict | undefined;
  const answer = verdict === undefined ? undefined : verdict.ok ? null : verdict.reason;
  const row = ref.row as Tool | undefined;
  if (!row || typeof row !== 'object' || !row.handler) {
    if (typeof answer !== 'string') return null;
    return Object.freeze({
      effect: 'write' as const,
      scope: 'any' as const,
      fields: Object.freeze({ memberApp: answer }),
    });
  }
  const builtin = ref.builtin as { readOnly: boolean; spends: boolean } | undefined;
  const own = appToolPolicy(row, builtin ?? null, MEMBER_APP_REFUSED_SLUGS);
  if (!own) return null;
  // Only the verdict answers the member-app rule (rules 1 to 5 and the
  // outside rules); the row's own reading of rules 2 to 4 is dropped.
  const { memberApp: _rowOnly, ...fields } = own.fields ?? {};
  return Object.freeze({
    ...own,
    fields: Object.freeze({ ...fields, ...(answer !== undefined ? { memberApp: answer } : {}) }),
  });
}

registerPolicySource('app-tool', appToolGatePolicy);
