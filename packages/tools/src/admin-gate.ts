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
  currentWorkspaceScope,
  scopeHasArea,
  scopeHoldsAdmin,
  scopeLeftForSystem,
  type ScopeArea,
  type WorkspaceScope,
} from '@mantle/db';

/**
 * Tools that read the owner's own history or the run machinery (workspaces
 * R3, W4b): adminOnly whatever group grants them. In a workspace turn scope
 * that does not hold the Admin workspace they are refused, as every
 * ownerOnly tool is. Matched on the row's slug AND its builtin handler ref,
 * so a row that renames a builtin is still caught. The heartbeat list and
 * fire tools reach every heartbeat of the brain: a heartbeat of another
 * workspace changes only its own row (heartbeats/tools.ts).
 */
export const ADMIN_ONLY_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'replay_window',
  'find_window',
  'export_node',
  'run_plan',
  'run_append',
  'run_state',
  'run_cancel',
  'run_audit',
  'heartbeat_list',
  'heartbeat_fire',
  // A shell on the server (MANTLE_MCP_TERMINAL): the brain's settings area
  // too (W7a fix round 1, M3), never any Admin-role login.
  'run_terminal',
]);

/** The refusal of an adminOnly tool outside the Admin workspace. */
export const ADMIN_ONLY_ERROR =
  'This tool belongs to the Admin workspace; it does not run in this workspace.';

/** The refusal of an Admin-area tool for a scope without that area. */
export function adminAreaError(area: ScopeArea): string {
  return `This tool manages the brain's ${area}: it runs only for a user of the Admin workspace whose ${area} area is on.`;
}

/** Whether `text` is one of the gate's refusals (the sweep reads it). */
export function isAdminGateRefusal(text: string): boolean {
  return text.includes(ADMIN_ONLY_ERROR) || /manages the brain's \w+: it runs only/.test(text);
}

/**
 * The Admin area each tool belongs to (W7a). The same idea as the API key
 * areas (@mantle/mcp-core key-scope.ts), for the areas an Admin workspace
 * user manages (plan 2.4). A tool with no area reads and writes brain items
 * in its caller's scope.
 */
export const TOOL_ADMIN_AREAS: ReadonlyMap<string, ScopeArea> = new Map<string, ScopeArea>([
  // The brain's settings: model routes and pools, capacity, sandboxes.
  ['model_catalog', 'settings'],
  ['model_pool_list', 'settings'],
  ['model_pool_set', 'settings'],
  ['model_pool_remove', 'settings'],
  ['brain_capacity', 'settings'],
  ['sandbox_autostart', 'settings'],
  ['sandbox_create', 'settings'],
  ['sandbox_exec', 'settings'],
  ['sandbox_export', 'settings'],
  ['sandbox_import', 'settings'],
  ['sandbox_list', 'settings'],
  ['sandbox_ls', 'settings'],
  ['sandbox_mcp_call', 'settings'],
  ['sandbox_mcp_tools', 'settings'],
  ['sandbox_publish', 'settings'],
  ['sandbox_rm', 'settings'],
  ['sandbox_stop', 'settings'],
  ['run_terminal', 'settings'],
  // Users: who reached the team surfaces, and the team chat portal.
  ['team_access_list', 'users'],
  ['team_chat_list', 'users'],
  ['team_chat_read', 'users'],
  // Assistants: agents, personas, tool and worker groups.
  ['agent_list', 'assistants'],
  ['agent_grant_tool_group', 'assistants'],
  ['agent_set_thinking_effort', 'assistants'],
  ['update_persona', 'assistants'],
  ['tool_group_ensure', 'assistants'],
  ['tool_group_list', 'assistants'],
  ['worker_group_ensure', 'assistants'],
  ['worker_group_list', 'assistants'],
  // The owner's heartbeats (the /api/heartbeats routes are this area). The
  // firing heartbeat's own tools (complete, snooze, state) are not listed:
  // a non-Admin assistant's fire reaches its own row (heartbeats/tools.ts),
  // and in an Admin scope they check this area themselves.
  ['heartbeat_list', 'assistants'],
  ['heartbeat_fire', 'assistants'],
  // Connectors: API tools, recipes, linked brains, Telegram.
  ['api_tool_create', 'connectors'],
  ['api_tool_delete', 'connectors'],
  ['api_tool_get', 'connectors'],
  ['api_tool_list', 'connectors'],
  ['api_tool_test', 'connectors'],
  ['api_tool_update', 'connectors'],
  ['api_docs_get', 'connectors'],
  ['api_docs_set', 'connectors'],
  ['api_skill_set', 'connectors'],
  ['recipe_tool_create', 'connectors'],
  ['recipe_tool_test', 'connectors'],
  ['peer_list', 'connectors'],
  ['peer_tools', 'connectors'],
  ['peer_call', 'connectors'],
  ['peer_query', 'connectors'],
  ['peer_node_get', 'connectors'],
  ['peer_search_chunks', 'connectors'],
  ['peer_file_copy', 'connectors'],
  ['telegram_pair', 'connectors'],
  ['telegram_send', 'connectors'],
  ['telegram_edit', 'connectors'],
  ['telegram_react', 'connectors'],
  ['telegram_pending', 'connectors'],
  ['telegram_mark_processed', 'connectors'],
  // The brain's mail (an Admin-only kind) through its mail accounts, whose
  // sealed credentials the workspace role never reads (the email routes are
  // the connectors area too, W6a).
  ['email_send', 'connectors'],
  ['email_list', 'connectors'],
  ['email_get', 'connectors'],
  ['email_page', 'connectors'],
  // Keys and secrets.
  ['secret_create', 'keys'],
  ['api_key_refs', 'keys'],
]);

/** The Admin area of a tool (by its slug or builtin ref), or null. */
export function toolAdminArea(slug: string, ref?: string): ScopeArea | null {
  return TOOL_ADMIN_AREAS.get(slug) ?? (ref ? (TOOL_ADMIN_AREAS.get(ref) ?? null) : null);
}

/**
 * The Admin-area tools that run WHOLE on the system pool after the area
 * check (W7a fix round 1, H1): each reads and writes system tables only
 * (model pools, sandbox rows and the sandbox daemon, agents, tool and
 * worker groups, heartbeats, API tools and their docs, peers and the remote
 * brains they reach, Telegram accounts and chats, secrets, the team access
 * log and chat portal), takes no item id and reads no brain item. Every
 * other area tool runs in the caller's scope and takes areaSystem only
 * around its own system tables: sandbox_create (it mounts a folder),
 * sandbox_import and sandbox_export (a file), peer_file_copy (a file),
 * recipe_tool_test (its steps are tools), email_send, email_page,
 * email_list and email_get (pages, files, contacts and mail rows),
 * run_terminal (no database). brain_capacity counts the brain's items
 * (numbers, never a row) for the settings area.
 */
export const AREA_SYSTEM_TOOLS: ReadonlySet<string> = new Set([
  'model_catalog',
  'model_pool_list',
  'model_pool_set',
  'model_pool_remove',
  'brain_capacity',
  'sandbox_autostart',
  'sandbox_exec',
  'sandbox_list',
  'sandbox_ls',
  'sandbox_mcp_call',
  'sandbox_mcp_tools',
  'sandbox_publish',
  'sandbox_rm',
  'sandbox_stop',
  'team_access_list',
  'team_chat_list',
  'team_chat_read',
  'agent_list',
  'agent_grant_tool_group',
  'agent_set_thinking_effort',
  'tool_group_ensure',
  'tool_group_list',
  'worker_group_ensure',
  'worker_group_list',
  'heartbeat_list',
  'api_tool_create',
  'api_tool_delete',
  'api_tool_get',
  'api_tool_list',
  'api_tool_test',
  'api_skill_set',
  'recipe_tool_create',
  'peer_list',
  'peer_tools',
  'peer_call',
  'peer_query',
  'peer_node_get',
  'peer_search_chunks',
  'telegram_pair',
  'telegram_send',
  'telegram_edit',
  'telegram_react',
  'telegram_pending',
  'telegram_mark_processed',
  'secret_create',
  'api_key_refs',
]);

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
  if (!currentWorkspaceScope()) return { system: false };
  const adminOnly =
    opts.ownerOnly ||
    ADMIN_ONLY_TOOL_SLUGS.has(slug) ||
    (opts.ref !== undefined && ADMIN_ONLY_TOOL_SLUGS.has(opts.ref));
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
  if (!currentWorkspaceScope()) return fn();
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
  return currentWorkspaceScope() ?? scopeLeftForSystem();
}
