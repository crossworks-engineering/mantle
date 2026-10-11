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
 *    and its limits leave the area on). Such a tool reads and writes system
 *    tables the workspace role is never granted (model pools, agents, tool
 *    groups, connectors, secrets, peers, Telegram accounts): AFTER the area
 *    check it runs on the system pool, by the one named reason
 *    'admin-area'. It reads no brain items there.
 *
 * Outside any workspace scope (system work, and MANTLE_ADMIN_READS=system)
 * the gate lets everything through: the surface rules decide, as before.
 */
import {
  asSystem,
  currentWorkspaceScope,
  scopeHasArea,
  scopeHoldsAdmin,
  type ScopeArea,
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

/** What the gate says about a call: refused (with the reply), or run, on
 *  the system pool (an Admin-area tool) or in the scope. */
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
  return { system: true };
}

/** Run `fn` as the gate said: on the system pool for an Admin-area tool
 *  (after its area check, by the named reason), else as is. */
export function runGated<T>(gate: { system: boolean }, fn: () => Promise<T>): Promise<T> {
  return gate.system ? asSystem(fn, 'admin-area') : fn();
}
