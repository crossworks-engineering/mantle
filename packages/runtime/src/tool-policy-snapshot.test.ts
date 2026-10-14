/**
 * The A5 step 1 snapshot (workspaces arch plan v2, section 23.3): the
 * literal value of every @mantle/tools access list that became a view of
 * the tool policy table, copied BEFORE the codemod that puts a policy on
 * every builtin. Each list, as the code reads it, must equal its literal
 * here; the literals never change, only how the list is read (CURRENT,
 * below). Since A5 step 6a no view is left: each consumer reads the tool's
 * policy, and CURRENT derives each list from the policies the same way.
 *
 * In @mantle/runtime: the lowest package that sees every builtin (this
 * package's heartbeat tools are builtins too, registered at boot) and
 * heartbeats/fire.ts's egress list. No database: the resolvers' probes
 * stay off it (the recall map lookup is stubbed).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/src/builtins-recall-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tools/src/builtins-recall-write')>()),
  mapRef: async (_ownerId: string, ref: string) =>
    ref === 'known' ? { id: 'map-node', version: 1, slug: 'known' } : null,
}));

import {
  LOGIN_APP_DATA_TOOLS,
  MCP_SURFACE_POLICIES,
  builtinItems,
  builtinPolicy,
  listBuiltins,
  memberAppRefusedName,
  policyAdminOnly,
  policyArea,
  policyLowers,
  policyMayLower,
  policyRecipeForbidden,
  policyRunItemBanned,
  policySystemWhole,
  policyUntrusted,
  type BuiltinToolDef,
  type ToolPolicy,
} from '@mantle/tools';
import { TEAM_PRIVATE_READ_SLUGS } from '@mantle/content';
import { registerHeartbeatTools } from './heartbeats/tools';
import UNTRUSTED_SNAPSHOT from './tool-policy-snapshot.untrusted.json' with { type: 'json' };

/** The builtins whose policy `pick` holds (read now: the heartbeat tools
 *  register below). */
const where = (pick: (p: ToolPolicy, def: BuiltinToolDef) => boolean) =>
  listBuiltins()
    .filter((d) => pick(d.policy, d))
    .map((d) => d.slug);

/** The retired team tools no team app calls, refused by name with no
 *  policy (member-app-tools.ts TEAM_TOOLS_REFUSED). */
const RETIRED_TEAM_TOOLS = ['my_items_list', 'my_item_open', 'team_request_create'];

/**
 * How each list is read today: A5 step 6a deleted the views, so each is the
 * set the consumers' policy reads answer, derived here from the policies
 * the same way the view derived it (the literals below never change).
 */
const CURRENT: Record<string, () => Iterable<string>> = {
  ADMIN_ONLY_TOOL_SLUGS: () => [
    ...where((p, d) => d.ownerOnly !== true && policyAdminOnly(p)),
    // The MCP surface's own definitions that are no builtin (the responder
    // writes into the owner's conversation), loaded in every process.
    ...Object.entries(MCP_SURFACE_POLICIES)
      .filter(([slug, p]) => !builtinPolicy(slug) && policyAdminOnly(p as ToolPolicy))
      .map(([slug]) => slug),
  ],
  OWNER_ONLY_IN_SCOPE: () => where((p, d) => d.ownerOnly === true && !policyAdminOnly(p)),
  AREA_SYSTEM_TOOLS: () => where(policySystemWhole),
  CREATE_TOOL_SLUGS: () => where((p) => p.creates !== undefined),
  LOWERING_TOOL_SLUGS: () => where(policyMayLower),
  RECIPE_FORBIDDEN_SLUGS: () => where(policyRecipeForbidden),
  MEMBER_APP_REFUSED_SLUGS: () => [
    ...where((p) => p.memberApp === 'refused'),
    ...RETIRED_TEAM_TOOLS.filter(memberAppRefusedName),
  ],
  BANNED_ITEM_TOOLS: () => where(policyRunItemBanned),
  UNTRUSTED_CONTENT_TOOL_SLUGS: () => where(policyUntrusted),
  // Read once, at definition time, from each app tool's own policy
  // (builtins-apps.ts withAuthorCeiling): no list is left.
  CODE_TOOLS: () => where((p) => p.outside?.appCode === true),
  APP_DATA_READ_TOOL_SLUGS: () =>
    LOGIN_APP_DATA_TOOLS.filter((d) => d.policy.effect === 'read').map((d) => d.slug),
  APP_DATA_WRITE_TOOL_SLUGS: () =>
    LOGIN_APP_DATA_TOOLS.filter((d) => d.policy.effect === 'write').map((d) => d.slug),
  HEARTBEAT_EGRESS_SLUGS: () => where((p) => p.outside?.egress === true),
};

/**
 * A literal copy of the name-keyed switch the policies replaced (main at
 * v0.300.39, packages/tools/src/client-sourced.ts isLoweringCall and its
 * two input rules), kept here as the fixed reference the policies are
 * compared with (A5 step 6a fix round 1, LOW-2): never derived from them.
 */
function mainIsLoweringCall(slug: string, input: Record<string, unknown>): boolean {
  const level = typeof input.level === 'string' ? input.level.trim().toLowerCase() : '';
  switch (slug) {
    case 'access_set':
      return level === 'client' || level === 'public';
    case 'node_share':
    case 'page_share':
      return true;
    case 'email_page':
      return input.includeLink === true || input.includeLink === 'true';
    default:
      return false;
  }
}

/** Whether a call lowers to client or public: the tool's policy. */
const isLoweringCall = (slug: string, input: Record<string, unknown>) => {
  const policy = builtinPolicy(slug);
  return policy !== null && policyLowers(policy, input);
};

/** The slug lists, each sorted (the order of a Set or a list was never
 *  part of what it decides). */
const LISTS: Record<string, readonly string[]> = {
  ADMIN_ONLY_TOOL_SLUGS: [
    'export_node',
    'find_window',
    'heartbeat_fire',
    'heartbeat_list',
    'pending_approve',
    'pending_get',
    'pending_list',
    'pending_reject',
    'recall_eval',
    'replay_window',
    'responder_turn_input',
    'responder_turn_record',
    'run_append',
    'run_audit',
    'run_cancel',
    'run_plan',
    'run_state',
    'run_terminal',
    'set_timezone',
  ],
  OWNER_ONLY_IN_SCOPE: [
    'app_build',
    'app_create',
    'app_db_schema_set',
    'app_db_seed',
    'app_delete',
    'app_deleted_list',
    'app_duplicate',
    'app_errors',
    'app_export',
    'app_file_delete',
    'app_file_write',
    'app_import',
    'app_publish',
    'app_snapshot_create',
    'app_snapshot_delete',
    'app_snapshot_list',
    'app_snapshot_restore',
    'app_source_set',
    'app_table_export_remove',
    'app_table_export_set',
    'app_tools_set',
    'app_undelete',
    'app_update',
    'page_move',
    'table_history',
    'table_snapshot_create',
    'table_snapshot_delete',
    'table_snapshot_restore',
    'tree_folder_create',
    'tree_folder_delete',
    'tree_folder_update',
    'tree_folders',
    'tree_item_move',
  ],
  AREA_SYSTEM_TOOLS: [
    'agent_grant_tool_group',
    'agent_list',
    'agent_set_thinking_effort',
    'api_key_refs',
    'api_skill_set',
    'api_tool_create',
    'api_tool_delete',
    'api_tool_get',
    'api_tool_list',
    'heartbeat_list',
    'model_catalog',
    'model_pool_list',
    'model_pool_remove',
    'model_pool_set',
    'peer_call',
    'peer_list',
    'peer_node_get',
    'peer_query',
    'peer_search_chunks',
    'peer_tools',
    'recipe_tool_create',
    'sandbox_autostart',
    'sandbox_exec',
    'sandbox_list',
    'sandbox_ls',
    'sandbox_mcp_call',
    'sandbox_mcp_tools',
    'sandbox_publish',
    'sandbox_rm',
    'sandbox_stop',
    'telegram_edit',
    'telegram_mark_processed',
    'telegram_pending',
    'telegram_react',
    'telegram_send',
    'tool_group_ensure',
    'tool_group_list',
    'worker_group_ensure',
    'worker_group_list',
  ],
  CREATE_TOOL_SLUGS: [
    'app_create',
    'app_duplicate',
    'app_import',
    'event_create',
    'file_copy',
    'file_create',
    'file_upload',
    'folder_copy',
    'folder_create',
    'formula_create',
    'generate_image',
    'note_create',
    'note_from_file',
    'note_from_page',
    'page_create',
    'page_extract_section',
    'page_from_file',
    'page_from_journal',
    'page_from_note',
    'page_from_notes',
    'page_split',
    'recall_map_create',
    'sheet_build',
    'table_create',
    'table_from_file',
    'table_from_text',
    'task_create',
    'tree_folder_create',
  ],
  LOWERING_TOOL_SLUGS: ['access_set', 'email_page', 'node_share', 'page_share'],
  RECIPE_FORBIDDEN_SLUGS: [
    'agent_grant_tool_group',
    'agent_list',
    'agent_set_thinking_effort',
    'api_key_refs',
    'api_tool_create',
    'api_tool_delete',
    'api_tool_get',
    'api_tool_list',
    'api_tool_test',
    'api_tool_update',
    'invoke_agent',
    'recipe_tool_create',
    'recipe_tool_test',
    'run_terminal',
    'sandbox_create',
    'sandbox_exec',
    'sandbox_mcp_call',
    'sandbox_publish',
    'sandbox_rm',
    'sandbox_stop',
    'secret_create',
    'tool_catalog',
    'tool_group_ensure',
    'tool_group_list',
    'update_persona',
    'web_fetch',
  ],
  MEMBER_APP_REFUSED_SLUGS: [
    'extract_from_image',
    'my_item_open',
    'my_items_list',
    'read_result',
    'search_chunks',
    'summarize_text',
    'team_request_create',
  ],
  BANNED_ITEM_TOOLS: [
    'invoke_agent',
    'run_append',
    'run_audit',
    'run_cancel',
    'run_plan',
    'run_state',
  ],
  // Shared with the @mantle/tools mocks of agent/tool-loop*.test.ts, so a
  // mock cannot drift from the snapshot.
  UNTRUSTED_CONTENT_TOOL_SLUGS: UNTRUSTED_SNAPSHOT,
  CODE_TOOLS: [
    'app_file_delete',
    'app_file_write',
    'app_publish',
    'app_snapshot_restore',
    'app_source_set',
    'app_tools_set',
  ],
  APP_DATA_READ_TOOL_SLUGS: ['app_data_list', 'app_data_query', 'app_data_schema'],
  APP_DATA_WRITE_TOOL_SLUGS: ['app_data_write'],
  // A5 step 5 (plan section 25) added email_page, peer_call, telegram_send,
  // web_crawl and web_search_pro; fix round 1 (owner decision 1a) web_map.
  HEARTBEAT_EGRESS_SLUGS: [
    'email_page',
    'email_send',
    'peer_call',
    'telegram_send',
    'web_crawl',
    'web_fetch',
    'web_map',
    'web_search',
    'web_search_pro',
  ],
};

/** TOOL_ADMIN_AREAS: the Admin area of each tool, sorted by slug. */
const AREAS: Record<string, string> = {
  agent_grant_tool_group: 'assistants',
  agent_list: 'assistants',
  agent_set_thinking_effort: 'assistants',
  api_docs_get: 'connectors',
  api_docs_set: 'connectors',
  api_key_refs: 'keys',
  api_skill_set: 'connectors',
  api_tool_create: 'connectors',
  api_tool_delete: 'connectors',
  api_tool_get: 'connectors',
  api_tool_list: 'connectors',
  api_tool_test: 'connectors',
  api_tool_update: 'connectors',
  brain_capacity: 'settings',
  email_get: 'connectors',
  email_list: 'connectors',
  email_page: 'connectors',
  email_send: 'connectors',
  heartbeat_fire: 'assistants',
  heartbeat_list: 'assistants',
  model_catalog: 'settings',
  model_pool_list: 'settings',
  model_pool_remove: 'settings',
  model_pool_set: 'settings',
  peer_call: 'connectors',
  peer_file_copy: 'connectors',
  peer_list: 'connectors',
  peer_node_get: 'connectors',
  peer_query: 'connectors',
  peer_search_chunks: 'connectors',
  peer_tools: 'connectors',
  recipe_tool_create: 'connectors',
  recipe_tool_test: 'connectors',
  run_terminal: 'settings',
  sandbox_autostart: 'settings',
  sandbox_create: 'settings',
  sandbox_exec: 'settings',
  sandbox_export: 'settings',
  sandbox_import: 'settings',
  sandbox_list: 'settings',
  sandbox_ls: 'settings',
  sandbox_mcp_call: 'settings',
  sandbox_mcp_tools: 'settings',
  sandbox_publish: 'settings',
  sandbox_rm: 'settings',
  sandbox_stop: 'settings',
  secret_create: 'keys',
  telegram_edit: 'connectors',
  telegram_mark_processed: 'connectors',
  telegram_pending: 'connectors',
  telegram_react: 'connectors',
  telegram_send: 'connectors',
  tool_group_ensure: 'assistants',
  tool_group_list: 'assistants',
  update_persona: 'assistants',
  worker_group_ensure: 'assistants',
  worker_group_list: 'assistants',
};

/** ITEM_WRITE_TARGETS: each slug's targets (the argument and what the
 *  write needs of it), or 'resolver' for one worked out from the input
 *  (its behaviour is pinned below). */
const ITEMS: Record<string, readonly { param: string; need: string }[] | 'resolver'> = {
  access_set: [{ param: 'node_id', need: 'manage' }],
  app_build: [{ param: 'id', need: 'edit' }],
  app_db_schema_set: [{ param: 'id', need: 'edit' }],
  app_db_seed: [{ param: 'id', need: 'edit' }],
  app_delete: [{ param: 'id', need: 'manage' }],
  app_duplicate: 'resolver',
  app_export: 'resolver',
  app_file_delete: [{ param: 'id', need: 'edit' }],
  app_file_write: [{ param: 'id', need: 'edit' }],
  app_publish: [{ param: 'id', need: 'edit' }],
  app_snapshot_create: [{ param: 'id', need: 'edit' }],
  app_snapshot_delete: [{ param: 'id', need: 'edit' }],
  app_snapshot_restore: [{ param: 'id', need: 'edit' }],
  app_source_set: [{ param: 'id', need: 'edit' }],
  app_table_export_remove: [{ param: 'id', need: 'edit' }],
  app_table_export_set: [{ param: 'id', need: 'edit' }],
  app_tools_set: [{ param: 'id', need: 'edit' }],
  app_update: [{ param: 'id', need: 'edit' }],
  contact_delete: [{ param: 'id', need: 'manage' }],
  contact_update: [{ param: 'id', need: 'edit' }],
  content_supersede: [{ param: 'node_id', need: 'edit' }],
  event_delete: [{ param: 'id', need: 'manage' }],
  event_update: [{ param: 'id', need: 'edit' }],
  file_delete: [{ param: 'file_id', need: 'manage' }],
  file_move: [{ param: 'file_id', need: 'manage' }],
  file_rename: [{ param: 'file_id', need: 'edit' }],
  file_set_indexing: [{ param: 'file_id', need: 'edit' }],
  folder_delete: [{ param: 'folder_id', need: 'manage' }],
  folder_describe: [{ param: 'folder_id', need: 'edit' }],
  folder_move: [{ param: 'folder_id', need: 'manage' }],
  folder_rename: [{ param: 'folder_id', need: 'edit' }],
  folder_set_indexing: [{ param: 'folder_id', need: 'edit' }],
  formula_delete: [{ param: 'id', need: 'manage' }],
  formula_update: [{ param: 'id', need: 'edit' }],
  journal_delete: [{ param: 'id', need: 'manage' }],
  journal_resolve_gap: [{ param: 'id', need: 'edit' }],
  journal_update: [{ param: 'id', need: 'edit' }],
  node_share: [{ param: 'id', need: 'edit' }],
  node_unshare: 'resolver',
  note_delete: [{ param: 'id', need: 'manage' }],
  note_update: [{ param: 'id', need: 'edit' }],
  page_block_append: [{ param: 'page_id', need: 'edit' }],
  page_block_delete: [{ param: 'page_id', need: 'edit' }],
  page_block_insert_after: [{ param: 'page_id', need: 'edit' }],
  page_block_insert_before: [{ param: 'page_id', need: 'edit' }],
  page_block_update: [{ param: 'page_id', need: 'edit' }],
  page_blocks_apply: [{ param: 'page_id', need: 'edit' }],
  page_commit: [{ param: 'id', need: 'edit' }],
  page_delete: [{ param: 'id', need: 'manage' }],
  page_discard_draft: [{ param: 'id', need: 'edit' }],
  page_extract_section: [{ param: 'page_id', need: 'edit' }],
  page_from_file: 'resolver',
  page_from_note: 'resolver',
  page_from_notes: 'resolver',
  page_mention: [{ param: 'page_id', need: 'edit' }],
  page_move: [{ param: 'id', need: 'manage' }],
  page_replace_from_file: [{ param: 'page_id', need: 'edit' }],
  page_share: [{ param: 'id', need: 'edit' }],
  page_split: [{ param: 'page_id', need: 'edit' }],
  page_unshare: 'resolver',
  page_update: [{ param: 'id', need: 'edit' }],
  page_update_draft: [{ param: 'id', need: 'edit' }],
  process_extraction: [{ param: 'node_id', need: 'read' }],
  recall_card_delete: 'resolver',
  recall_card_put: 'resolver',
  recall_card_set_slug: 'resolver',
  recall_cards_reorder: 'resolver',
  recall_map_delete: 'resolver',
  recall_map_publish: 'resolver',
  recall_map_set_slug: 'resolver',
  recall_map_update: 'resolver',
  recall_prompt_confirm: 'resolver',
  recall_revision_restore: 'resolver',
  table_cell_set: [{ param: 'table_id', need: 'edit' }],
  table_column_add: [{ param: 'table_id', need: 'edit' }],
  table_column_delete: [{ param: 'table_id', need: 'edit' }],
  table_column_update: [{ param: 'table_id', need: 'edit' }],
  table_commit: [{ param: 'id', need: 'edit' }],
  table_delete: [{ param: 'id', need: 'manage' }],
  table_row_add: [{ param: 'table_id', need: 'edit' }],
  table_row_delete: [{ param: 'table_id', need: 'edit' }],
  table_row_update: [{ param: 'table_id', need: 'edit' }],
  table_rows_add: [{ param: 'table_id', need: 'edit' }],
  table_rows_upsert: [{ param: 'table_id', need: 'edit' }],
  table_set_aggregate: [{ param: 'table_id', need: 'edit' }],
  table_set_view: [{ param: 'table_id', need: 'edit' }],
  table_snapshot_create: [{ param: 'id', need: 'edit' }],
  table_snapshot_delete: [{ param: 'id', need: 'edit' }],
  table_snapshot_restore: [{ param: 'id', need: 'edit' }],
  table_tab_add: [{ param: 'table_id', need: 'edit' }],
  table_tab_delete: [{ param: 'table_id', need: 'edit' }],
  table_tab_rename: [{ param: 'table_id', need: 'edit' }],
  table_update: [{ param: 'id', need: 'edit' }],
  task_delete: [{ param: 'id', need: 'manage' }],
  task_update: [{ param: 'id', need: 'edit' }],
  tree_folder_delete: [{ param: 'folder_id', need: 'manage' }],
  tree_folder_update: 'resolver',
  tree_item_move: [{ param: 'item_ids', need: 'manage' }],
};

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('every @mantle/tools access list equals its literal (A5 step 1)', () => {
  registerHeartbeatTools();

  it('names every list it holds', () => {
    expect(Object.keys(CURRENT).sort()).toEqual(Object.keys(LISTS).sort());
  });

  for (const name of Object.keys(LISTS)) {
    it(name, () => {
      const now = sorted(CURRENT[name]!());
      expect(now).toEqual(LISTS[name]);
      // No list holds a slug twice.
      expect(new Set(now).size).toBe(now.length);
    });
  }

  it('TEAM_PRIVATE_READ_SLUGS, the published contract list, names the private corpus reads', () => {
    // Kept in @mantle/content-core for one jackdaw pair release (A5 step
    // 6a); the brain's turns read each tool's policy (`privateCorpus`).
    expect(where((p) => p.privateCorpus === true).sort()).toEqual(
      [...TEAM_PRIVATE_READ_SLUGS].sort(),
    );
    expect([...TEAM_PRIVATE_READ_SLUGS].sort()).toEqual([
      'email_get',
      'email_list',
      'journal_get',
      'journal_list',
    ]);
  });

  it('TOOL_ADMIN_AREAS', () => {
    expect(
      Object.fromEntries(
        listBuiltins().flatMap((d) => {
          const area = policyArea(d.policy);
          return area ? [[d.slug, area] as const] : [];
        }),
      ),
    ).toEqual(AREAS);
  });

  it("ITEM_WRITE_TARGETS: the slugs and each one's targets", () => {
    const now = Object.fromEntries(
      listBuiltins().flatMap((d) => {
        const v = d.policy.items;
        return v ? [[d.slug, typeof v === 'function' ? 'resolver' : v] as const] : [];
      }),
    );
    expect(now).toEqual(ITEMS);
  });

  /** A resolver's targets for `input` (no database: see each probe). */
  const resolve = (slug: string, input: Record<string, unknown>) => {
    const r = builtinItems(slug);
    if (typeof r !== 'function') throw new Error(`${slug} has no resolver`);
    return r(input, 'owner-1');
  };

  it('ITEM_WRITE_TARGETS: what each resolver works out', async () => {
    // Closing a link: outside any scope, the item's edit.
    for (const slug of ['page_unshare', 'node_unshare']) {
      expect(await resolve(slug, { id: ' x ' })).toEqual([{ ids: ['x'], need: 'edit' }]);
      expect(await resolve(slug, {})).toEqual([]);
    }
    // A folder update: a new parent is a move.
    expect(await resolve('tree_folder_update', { folder_id: 'f' })).toEqual([
      { ids: ['f'], need: 'edit' },
    ]);
    expect(await resolve('tree_folder_update', { folder_id: 'f', parent_id: null })).toEqual([
      { ids: ['f'], need: 'manage' },
    ]);
    expect(await resolve('tree_folder_update', {})).toEqual([]);
    // A conversion retires its source unless told not to.
    expect(await resolve('page_from_note', { note_id: 'n' })).toEqual([
      { ids: ['n'], need: 'edit' },
    ]);
    expect(await resolve('page_from_note', { note_id: 'n', supersede_source: false })).toEqual([]);
    expect(await resolve('page_from_file', { file_id: 'f' })).toEqual([
      { ids: ['f'], need: 'edit' },
    ]);
    expect(await resolve('page_from_file', { file_id: 'f', supersede_source: false })).toEqual([]);
    expect(await resolve('page_from_notes', { note_ids: ['a', 1, 'b'] })).toEqual([
      { ids: ['a', 'b'], need: 'edit' },
    ]);
    expect(await resolve('page_from_notes', { note_ids: ['a'], supersede_source: false })).toEqual(
      [],
    );
    // A copy of an app: the code alone needs a read; with its data, an
    // app this probe cannot look up (no uuid) needs the edit.
    for (const slug of ['app_duplicate', 'app_export']) {
      expect(await resolve(slug, {})).toEqual([]);
      expect(await resolve(slug, { id: 'a', with_data: false })).toEqual([
        { ids: ['a'], need: 'read' },
      ]);
      expect(await resolve(slug, { id: 'a' })).toEqual([{ ids: ['a'], need: 'edit' }]);
    }
    // A recall map, by slug (the lookup stubbed): the delete manages.
    for (const slug of [
      'recall_map_update',
      'recall_card_put',
      'recall_card_delete',
      'recall_cards_reorder',
      'recall_card_set_slug',
      'recall_map_set_slug',
      'recall_prompt_confirm',
      'recall_map_publish',
      'recall_map_delete',
    ]) {
      const need = slug === 'recall_map_delete' ? 'manage' : 'edit';
      expect(await resolve(slug, { map: 'known' }), slug).toEqual([{ ids: ['map-node'], need }]);
      expect(await resolve(slug, { map: 'other' }), slug).toEqual([]);
      expect(await resolve(slug, {}), slug).toEqual([]);
    }
    // A revision by an id that is not one.
    expect(await resolve('recall_revision_restore', { revision_id: 'nope' })).toEqual([]);
    // Every resolver is probed above.
    const probed = new Set([
      'page_unshare',
      'node_unshare',
      'tree_folder_update',
      'page_from_note',
      'page_from_file',
      'page_from_notes',
      'app_duplicate',
      'app_export',
      'recall_map_update',
      'recall_card_put',
      'recall_card_delete',
      'recall_cards_reorder',
      'recall_card_set_slug',
      'recall_map_set_slug',
      'recall_prompt_confirm',
      'recall_map_publish',
      'recall_map_delete',
      'recall_revision_restore',
    ]);
    expect(
      Object.keys(ITEMS)
        .filter((k) => ITEMS[k] === 'resolver')
        .sort(),
    ).toEqual([...probed].sort());
  });

  it('isLoweringCall: which calls lower an item to client or public', () => {
    expect(isLoweringCall('access_set', { level: ' Client ' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'public' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'team' })).toBe(false);
    expect(isLoweringCall('access_set', {})).toBe(false);
    expect(isLoweringCall('node_share', {})).toBe(true);
    expect(isLoweringCall('page_share', {})).toBe(true);
    expect(isLoweringCall('email_page', { includeLink: true })).toBe(true);
    expect(isLoweringCall('email_page', { includeLink: 'true' })).toBe(true);
    expect(isLoweringCall('email_page', { includeLink: false })).toBe(false);
    expect(isLoweringCall('email_page', {})).toBe(false);
    expect(isLoweringCall('page_update', { level: 'public' })).toBe(false);
    expect(isLoweringCall('no_such_tool', {})).toBe(false);
  });

  it("each builtin's policy.lowering says what main's lowering switch said", () => {
    const probes = [
      {},
      { level: 'client' },
      { level: ' Public ' },
      { level: 'team' },
      { includeLink: true },
      { includeLink: 'true' },
      { includeLink: false },
    ];
    for (const d of listBuiltins()) {
      for (const input of probes) {
        expect(policyLowers(d.policy, input), `${d.slug} ${JSON.stringify(input)}`).toBe(
          mainIsLoweringCall(d.slug, input),
        );
      }
    }
  });
});
