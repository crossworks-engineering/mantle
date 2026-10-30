/**
 * The Admin gate of a tool call in a workspace scope. The Admin assistant
 * and the Admin MCP surface run in a scope like every other user, so a
 * tool's call is gated by the scope it runs in, never by who the caller
 * says it is:
 *
 *  - an ownerOnly or adminOnly tool runs only in a scope that holds the
 *    Admin workspace (scopeHoldsAdmin);
 *  - a tool of an Admin AREA (its policy's area: the brain's settings,
 *    assistants, connectors, keys and users) runs only when the scope may
 *    do that area (scopeHasArea: it holds Admin, its login is a user there
 *    and its limits leave the area on).
 *
 * After the area check an area tool still runs IN THE CALLER'S SCOPE: its
 * item reads and writes (a file it imports or
 * exports, a page it mails, a folder it mounts, a recipe's steps) are the
 * scope's, with the normal edit and create checks. Its own system tables
 * (sandbox rows, peers, mail accounts, tool groups), which the workspace
 * role is never granted, it reads through areaSystem, by the one named
 * reason 'admin-area'. Only the tools whose policy says `systemWhole` run whole on
 * the system pool: each of them reads and writes system tables only, takes
 * no item id and reads no brain item (a test pins that). A new area tool
 * does not say it, so it runs in the scope until it is shown not to touch
 * an item: fail closed.
 *
 * Outside any workspace scope (system work) the gate lets everything
 * through: the surface rules decide.
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
import { ADMIN_ONLY_ERROR, adminAreaError } from '@mantle/std';

/**
 * This file's one system door: an Admin-area tool's own system tables,
 * after its area check, by the named reason 'admin-area' (runGated and
 * areaSystem below).
 */
function adminAreaSystem<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(fn, 'admin-area');
}

/** What a scope may list: whether it holds Admin, and the
 *  Admin areas it may do. Read once per MCP connection. */
export type AdminGateView = { holdsAdmin: boolean; areas: ReadonlySet<ScopeArea> };

/**
 * What the current workspace scope holds of Admin, as an Admin step reads
 * it: whether it holds the Admin workspace (scopeHoldsAdmin), and which of
 * `areas` it may do there (scopeHasArea; none when it does not hold Admin).
 * The one read of it: a tool call's gate caller, an MCP connection's list
 * and call, a pending call's stamp and its re-check. Asked in the scope.
 */
export async function scopeAdminView(areas: readonly ScopeArea[]): Promise<AdminGateView> {
  const holdsAdmin = await scopeHoldsAdmin();
  const held = new Set<ScopeArea>();
  if (holdsAdmin) for (const a of areas) if (await scopeHasArea(a)) held.add(a);
  return { holdsAdmin, areas: held };
}

/** The refusals of an adminOnly tool outside the Admin workspace and of an
 *  Admin-area tool for a scope without that area: the words of the one
 *  mapper (@mantle/std access-error.ts), said the same by the
 *  gate. */
export { ADMIN_ONLY_ERROR, adminAreaError } from '@mantle/std';

/** Whether `text` is one of the gate's refusals (the sweep reads it). */
export function isAdminGateRefusal(text: string): boolean {
  return text.includes(ADMIN_ONLY_ERROR) || /manages the brain's \w+: it runs only/.test(text);
}

/*
 * The Admin areas. The same idea as the API key areas
 * (@mantle/mcp-core key-scope.ts), for the areas an Admin workspace user
 * manages. A tool with no area reads and writes brain items in its
 * caller's scope. A tool's area is its policy's scope (tool-policy.ts
 * policyArea). The areas: the brain's
 * settings (model routes and pools, capacity, sandboxes, the server
 * shell); assistants (agents, personas, tool and worker groups, the
 * owner's heartbeats: the /api/heartbeats routes are this area; the firing
 * heartbeat's own tools are not, a non-Admin assistant's fire reaches its
 * own row, heartbeats/tools.ts); connectors (API tools, recipes, linked
 * brains, Telegram, and the brain's mail, an Admin-only kind whose sealed
 * mail account credentials the workspace role never reads); keys and
 * secrets.
 */

/*
 * The Admin-area tools that run WHOLE on the system pool after the area
 * check. Each reads and writes system tables only, takes no item id, reads and
 * writes no brain item (nodes, chunks, facts, windows, grants, files,
 * Journal, contacts, mail) and runs no other tool or assistant turn:
 *
 *  - model_catalog, model_pool_list, model_pool_set, model_pool_remove:
 *    curated_models and the provider's model catalog.
 *  - sandbox_autostart, sandbox_exec, sandbox_list, sandbox_ls,
 *    sandbox_mcp_call, sandbox_mcp_tools, sandbox_publish, sandbox_rm,
 *    sandbox_stop: sandbox rows and the sandbox daemon (publish: the proxy
 *    API key, only with the keys area, and the sandbox's own tool group,
 *    never another group). A sandbox is its maker's: the brain owner's login
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
 *  - api_key_set, api_key_test, api_key_delete, api_key_import: the vault
 *    (api_keys) and its audit rows, through the vault's write gateway, which
 *    asks the keys area again (@mantle/api-keys vault.ts); the CSV is text,
 *    never a file; a token's test sends it to its provider only.
 *  - peer_list, peer_tools, peer_call, peer_query, peer_node_get,
 *    peer_search_chunks: peer rows and the linked brain over its link (the
 *    ids they take name the PEER's items, never this brain's).
 *  - telegram_send, telegram_edit, telegram_react, telegram_pending,
 *    telegram_mark_processed: Telegram accounts, chats and messages, and
 *    the Bot API (text only), each on the caller's own paired chats only.
 *    telegram_pair has no area: any user pairs their own chat; it leaves
 *    the scope itself, by name.
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
 * Declared on each tool's policy: an area scope marked `systemWhole`
 * (tool-policy.ts policySystemWhole).
 */

/** Run `fn` as the gate said: whole on the system pool for an
 *  `systemWhole` tool (after its area check, by the named reason), else
 *  in the caller's scope. */
export function runGated<T>(gate: { system: boolean }, fn: () => Promise<T>): Promise<T> {
  return gate.system ? adminAreaSystem(fn) : fn();
}

/**
 * An Admin-area tool's own system-table work: its
 * sandbox row, its peer, its mail account. In a workspace scope it runs on
 * the system pool by the named reason 'admin-area', and only when the scope
 * may do `area` (the gate checked it; asked again here so a helper reached
 * some other way never leaves the scope). Outside a workspace scope it runs
 * as is. Never for an item: items are read and written in the scope.
 */
export async function areaSystem<T>(area: ScopeArea, fn: () => Promise<T>): Promise<T> {
  if (!currentWorkspaceScope()) return fn();
  if (!(await scopeHasArea(area))) throw new Error(adminAreaError(area));
  return adminAreaSystem(fn);
}

/**
 * The workspace scope of the call the current code serves: the open one,
 * or, on the system pool (an `systemWhole` tool run whole, an areaSystem
 * block), the one its asSystem left. Null outside any
 * workspace scope: system work, where the surface rules decide.
 */
export function callerScope(): WorkspaceScope | null {
  return currentWorkspaceScope() ?? scopeLeftForSystem();
}

/** Whether the caller of the current code may do Admin `area`: the one
 *  answer, @mantle/db's (scope-answers.ts), shared with the vault's write
 *  gateway. */
export { callerHasArea } from '@mantle/db';
