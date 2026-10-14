/**
 * The Admin gate of a tool call in a workspace scope (workspaces W4b, plan
 * 5.4; W7a). Since W7a the Admin assistant and the Admin MCP surface run in
 * a scope like every other user, so a tool's call is gated by the scope it
 * runs in, never by who the caller says it is:
 *
 *  - an ownerOnly or adminOnly tool runs only in a scope that holds the
 *    Admin workspace (scopeHoldsAdmin);
 *  - a tool of an Admin AREA (TOOL_ADMIN_AREAS: the brain's settings,
 *    assistants, connectors, keys and users) runs only when the scope may
 *    do that area (scopeHasArea: it holds Admin, its login is a user there
 *    and its limits leave the area on).
 *
 * After the area check an area tool still runs IN THE CALLER'S SCOPE (W7a
 * fix round 1, H1): its item reads and writes (a file it imports or
 * exports, a page it mails, a folder it mounts, a recipe's steps) are the
 * scope's, with the normal edit and create checks. Its own system tables
 * (sandbox rows, peers, mail accounts, tool groups), which the workspace
 * role is never granted, it reads through areaSystem, by the one named
 * reason 'admin-area'. Only the tools of AREA_SYSTEM_TOOLS run whole on
 * the system pool: each of them reads and writes system tables only, takes
 * no item id and reads no brain item (a test pins that). A new area tool is
 * not on that list, so it runs in the scope until it is shown not to touch
 * an item: fail closed.
 *
 * Outside any workspace scope (system work, and MANTLE_ADMIN_READS=system)
 * the gate lets everything through: the surface rules decide, as before.
 */
import {
  asSystem,
  currentGateScope,
  loginHasArea,
  currentWorkspaceScope,
  scopeHasArea,
  scopeHoldsAdmin,
  scopeLeftForSystem,
  withTurnScope,
  type ScopeArea,
  type WorkspaceScope,
} from '@mantle/db';
import { ADMIN_ONLY_ERROR, adminAreaError } from '@mantle/std';
import { policyAdminOnly, policySlugMap, policySlugSet } from './tool-policy';

/**
 * Tools that read the owner's own history or the run machinery (workspaces
 * R3, W4b): adminOnly whatever group grants them. In a workspace turn scope
 * that does not hold the Admin workspace they are refused, as every
 * ownerOnly tool is. Matched on the row's slug AND its builtin handler ref,
 * so a row that renames a builtin is still caught. The heartbeat list and
 * fire tools reach every heartbeat of the brain: a heartbeat of another
 * workspace changes only its own row (heartbeats/tools.ts).
 *
 * A view of the tool policy table (tool-policy.ts, A5): the builtins whose
 * policy is adminOnly (scope `admin`, or an area marked adminOnly) and that
 * are not ownerOnly (those are adminOnly by OWNER_ONLY_IN_SCOPE), plus the
 * MCP surface's own definitions that are adminOnly (A5 step 2: the two
 * responder tools that write into the owner's conversation), whose policies
 * every process loads (mcp-surface-policies.ts, fix round 1). Since W7b
 * every login has the owner MCP surface (workspaces plan 7.4): the owner's
 * own approvals queue, profile clock, assistant conversation and retrieval
 * eval stay Admin; so does a shell on the server (run_terminal, the
 * settings area too, W7a fix round 1, M3), never any Admin-role login.
 */
export const ADMIN_ONLY_TOOL_SLUGS: ReadonlySet<string> = policySlugSet(
  (p, def) => def.ownerOnly !== true && policyAdminOnly(p),
  { surface: (p, def) => def.ownerOnly !== true && policyAdminOnly(p) },
);

/**
 * The ownerOnly builtins that run in ANY user's scope since workspaces W7b
 * (plan 7.4: one MCP surface for every login): they read and change items
 * (apps, folders of the row-only trees, a page's place, a table's history),
 * and the scope and the database's checks decide which (a create lands by
 * the route rule; a move, a create in a folder and a delete are checked
 * against the scope). `ownerOnly` still keeps them off a team or client
 * turn surface (dispatch, and each handler's own owner-surface check).
 * Every OTHER ownerOnly builtin is adminOnly: it runs only in a scope that
 * holds the Admin workspace. A view of the tool policy table: the ownerOnly
 * builtins whose policy is not adminOnly.
 */
export const OWNER_ONLY_IN_SCOPE: ReadonlySet<string> = policySlugSet(
  (p, def) => def.ownerOnly === true && !policyAdminOnly(p),
);

/** Whether a tool is adminOnly: listed, or ownerOnly and not one of the
 *  ownerOnly tools that run in any user's scope (by slug or builtin ref). */
export function isAdminOnlyTool(slug: string, opts: { ref?: string; ownerOnly?: boolean } = {}) {
  const ref = opts.ref;
  if (ADMIN_ONLY_TOOL_SLUGS.has(slug) || (ref !== undefined && ADMIN_ONLY_TOOL_SLUGS.has(ref))) {
    return true;
  }
  return opts.ownerOnly === true && !OWNER_ONLY_IN_SCOPE.has(ref ?? slug);
}

/** What a scope may list (workspaces W7b): whether it holds Admin, and the
 *  Admin areas it may do. Read once per MCP connection. */
export type AdminGateView = { holdsAdmin: boolean; areas: ReadonlySet<ScopeArea> };

/**
 * Whether a tool is LISTED for a scope with `view` (W7b): an adminOnly tool
 * only where the scope holds Admin, an Admin-area tool only where the area
 * is on. The call is still gated (adminToolGate): listing is not the check.
 */
export function adminGateLists(
  slug: string,
  view: AdminGateView,
  opts: { ref?: string; ownerOnly?: boolean } = {},
): boolean {
  const area = toolAdminArea(slug, opts.ref);
  if ((isAdminOnlyTool(slug, opts) || area) && !view.holdsAdmin) return false;
  return !area || view.areas.has(area);
}

/** The refusals of an adminOnly tool outside the Admin workspace and of an
 *  Admin-area tool for a scope without that area: the words of the one
 *  mapper (@mantle/std access-error.ts, arch A3c), said the same by the
 *  gate. */
export { ADMIN_ONLY_ERROR, adminAreaError } from '@mantle/std';

/** Whether `text` is one of the gate's refusals (the sweep reads it). */
export function isAdminGateRefusal(text: string): boolean {
  return text.includes(ADMIN_ONLY_ERROR) || /manages the brain's \w+: it runs only/.test(text);
}

/**
 * The Admin area each tool belongs to (W7a). The same idea as the API key
 * areas (@mantle/mcp-core key-scope.ts), for the areas an Admin workspace
 * user manages (plan 2.4). A tool with no area reads and writes brain items
 * in its caller's scope.
 *
 * A view of the tool policy table: each builtin whose policy's scope names
 * an area. The areas: the brain's settings (model routes and pools,
 * capacity, sandboxes, the server shell); assistants (agents, personas,
 * tool and worker groups, the owner's heartbeats: the /api/heartbeats
 * routes are this area; the firing heartbeat's own tools are not, a
 * non-Admin assistant's fire reaches its own row, heartbeats/tools.ts);
 * connectors (API tools, recipes, linked brains, Telegram, and the brain's
 * mail, an Admin-only kind whose sealed mail account credentials the
 * workspace role never reads, W6a); keys and secrets.
 */
export const TOOL_ADMIN_AREAS: ReadonlyMap<string, ScopeArea> = policySlugMap((p) =>
  typeof p.scope === 'object' ? p.scope.area : undefined,
);

/** The Admin area of a tool (by its slug or builtin ref), or null. */
export function toolAdminArea(slug: string, ref?: string): ScopeArea | null {
  return TOOL_ADMIN_AREAS.get(slug) ?? (ref ? (TOOL_ADMIN_AREAS.get(ref) ?? null) : null);
}

/**
 * The Admin-area tools that run WHOLE on the system pool after the area
 * check (W7a fix round 1, H1; re-checked handler by handler in fix round 2).
 * Each reads and writes system tables only, takes no item id, reads and
 * writes no brain item (nodes, chunks, facts, windows, grants, files,
 * Journal, contacts, mail) and runs no other tool or assistant turn:
 *
 *  - model_catalog, model_pool_list, model_pool_set, model_pool_remove:
 *    curated_models and the provider's model catalog.
 *  - sandbox_autostart, sandbox_exec, sandbox_list, sandbox_ls,
 *    sandbox_mcp_call, sandbox_mcp_tools, sandbox_publish, sandbox_rm,
 *    sandbox_stop: sandbox rows and the sandbox daemon (publish: the proxy
 *    API key, only with the keys area, and the sandbox's own tool group,
 *    never another group, fix round 3). A sandbox is its maker's: the brain owner's login
 *    works in every one, any other login only in its own (callerScope), and
 *    only the brain owner mounts a folder (sandbox/common.ts).
 *  - agent_list, agent_grant_tool_group, agent_set_thinking_effort,
 *    tool_group_ensure, tool_group_list, worker_group_ensure,
 *    worker_group_list: agents, tool and worker groups, tools, pending calls.
 *  - heartbeat_list: heartbeat rows.
 *  - api_tool_create, api_tool_delete, api_tool_get, api_tool_list,
 *    api_skill_set, recipe_tool_create, api_key_refs: tools, tool groups,
 *    skills, the makers of the heartbeats that run a saved skill
 *    (heartbeat-maker.ts), API key names (recipe steps are checked against
 *    tool rows, never run).
 *  - peer_list, peer_tools, peer_call, peer_query, peer_node_get,
 *    peer_search_chunks: peer rows and the linked brain over its link (the
 *    ids they take name the PEER's items, never this brain's).
 *  - telegram_send, telegram_edit, telegram_react, telegram_pending,
 *    telegram_mark_processed: Telegram accounts, chats and messages, and
 *    the Bot API (text only), each on the caller's own paired chats only
 *    (W7d). telegram_pair has no area: any user pairs their own chat (the
 *    owner's answer 1A); it leaves the scope itself, by name.
 *
 * Every other area tool runs in the caller's scope and takes areaSystem only
 * around its own system tables: sandbox_create (its folder), sandbox_import
 * and sandbox_export (a file), peer_file_copy (a file), recipe_tool_test (its
 * steps are tools), api_tool_test (it runs the tool), api_docs_set and
 * api_docs_get (the docs file), update_persona (Journal entries),
 * heartbeat_fire (a turn, in the caller's scope), secret_create (the secret
 * node; its Secrets root on the system pool), brain_capacity (two counts on the system pool, numbers only; its score's
 * note in the scope), the email tools (pages, files, contacts and mail
 * rows), run_terminal (no database). A test runs each listed tool with item
 * tables closed to the system pool (server/web/server/w7a-area-system-sweep.db.test.ts).
 * A view of the tool policy table: the area scopes marked `systemWhole`.
 */
export const AREA_SYSTEM_TOOLS: ReadonlySet<string> = policySlugSet(
  (p) => typeof p.scope === 'object' && p.scope.systemWhole === true,
);

/** What the gate says about a call: refused (with the reply), or run, whole
 *  on the system pool (an AREA_SYSTEM_TOOLS tool) or in the scope. */
export type AdminGate = { refused: string } | { system: boolean };

/**
 * Gate one call of tool `slug` (its builtin `ref`, when it has one) in the
 * current scope. `ownerOnly`: the builtin is owner-only.
 */
export async function adminToolGate(
  slug: string,
  opts: { ref?: string; ownerOnly?: boolean } = {},
): Promise<AdminGate> {
  if (!currentWorkspaceScope()) {
    // The rollback switch's gate scope (W7 integration fix 2, M6): the
    // call reads on the system pool, the gate still asks the login.
    const g = currentGateScope();
    if (!g) return { system: false };
    const gAdminOnly = isAdminOnlyTool(slug, opts);
    const gArea = toolAdminArea(slug, opts.ref);
    if ((gAdminOnly || gArea) && !(await withTurnScope(g, () => scopeHoldsAdmin()))) {
      return { refused: ADMIN_ONLY_ERROR };
    }
    if (gArea && !(g.loginId && (await loginHasArea(g.loginId, gArea)))) {
      return { refused: adminAreaError(gArea) };
    }
    return { system: false };
  }
  const adminOnly = isAdminOnlyTool(slug, opts);
  const area = toolAdminArea(slug, opts.ref);
  if ((adminOnly || area) && !(await scopeHoldsAdmin())) return { refused: ADMIN_ONLY_ERROR };
  if (!area) return { system: false };
  if (!(await scopeHasArea(area))) return { refused: adminAreaError(area) };
  const whole =
    AREA_SYSTEM_TOOLS.has(slug) || (opts.ref !== undefined && AREA_SYSTEM_TOOLS.has(opts.ref));
  return { system: whole };
}

/** Run `fn` as the gate said: whole on the system pool for an
 *  AREA_SYSTEM_TOOLS tool (after its area check, by the named reason), else
 *  in the caller's scope. */
export function runGated<T>(gate: { system: boolean }, fn: () => Promise<T>): Promise<T> {
  return gate.system ? asSystem(fn, 'admin-area') : fn();
}

/**
 * An Admin-area tool's own system-table work (W7a fix round 1, H1): its
 * sandbox row, its peer, its mail account. In a workspace scope it runs on
 * the system pool by the named reason 'admin-area', and only when the scope
 * may do `area` (the gate checked it; asked again here so a helper reached
 * some other way never leaves the scope). Outside a workspace scope it runs
 * as is. Never for an item: items are read and written in the scope.
 */
export async function areaSystem<T>(area: ScopeArea, fn: () => Promise<T>): Promise<T> {
  if (!currentWorkspaceScope()) {
    // Under the rollback switch the gate scope's login is asked (M6).
    const g = currentGateScope();
    if (g && !(g.loginId && (await loginHasArea(g.loginId, area)))) {
      throw new Error(adminAreaError(area));
    }
    return fn();
  }
  if (!(await scopeHasArea(area))) throw new Error(adminAreaError(area));
  return asSystem(fn, 'admin-area');
}

/**
 * The workspace scope of the call the current code serves (W7a fix round
 * 2): the open one, or, on the system pool (an AREA_SYSTEM_TOOLS tool run
 * whole, an areaSystem block), the one its asSystem left. Null outside any
 * workspace scope: system work, where the surface rules decide.
 */
export function callerScope(): WorkspaceScope | null {
  return currentWorkspaceScope() ?? scopeLeftForSystem() ?? currentGateScope();
}

/**
 * Whether the caller of the current code may do Admin `area` (W7a fix round
 * 3): asked in the open workspace scope, or, on the system pool (an
 * AREA_SYSTEM_TOOLS tool run whole, an areaSystem block), in the scope its
 * asSystem left, so a connectors-area tool can ask whether its caller also
 * holds the keys area. Outside any workspace scope (system work): yes, the
 * surface rules decide, as before.
 */
export async function callerHasArea(area: ScopeArea): Promise<boolean> {
  if (currentWorkspaceScope()) return scopeHasArea(area);
  const left = scopeLeftForSystem();
  if (!left) {
    // The rollback switch's gate scope (M6): the login's own areas.
    const g = currentGateScope();
    if (!g) return true;
    return g.loginId ? loginHasArea(g.loginId, area) : false;
  }
  return withTurnScope(left, () => scopeHasArea(area));
}
