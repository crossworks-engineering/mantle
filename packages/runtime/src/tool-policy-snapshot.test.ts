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
 * stay off it.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LOGIN_APP_DATA_TOOLS,
  MCP_SURFACE_POLICIES,
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

/** The scoreboard's numbers (eslint-rules/arch-counts.mjs measure()), read
 *  once for the tests that compare the registry with them. */
let measured: Promise<Record<string, number>> | null = null;
const scoreboard = () =>
  (measured ??= (async () => {
    // @ts-expect-error: plain-JS module, no types shipped.
    const { measure } = await import('../../../eslint-rules/arch-counts.mjs');
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    return (measure(root) as { numbers: Record<string, number> }).numbers;
  })());

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

  it('ITEM_WRITE_TARGETS: none is left, and the scoreboard counts 0 (A5 step 6b pin)', async () => {
    // The pre-check removal took the last 29 tool item pre-checks in Part 3
    // (docs/actors.md): no policy declares items, and the static counter
    // (eslint-rules/arch-counts.mjs, itemPrecheckTools, pinned at 0) would
    // see one that came back in any of its old forms.
    const policies = [
      ...listBuiltins().map((d) => d.policy),
      ...Object.values(MCP_SURFACE_POLICIES),
    ];
    expect(policies.filter((p) => 'items' in p || 'legacyItemPrecheck' in p)).toEqual([]);
    expect((await scoreboard()).itemPrecheckTools).toBe(0);
  }, 60_000);

  it('systemWholeTools: the scoreboard counts every systemWhole policy the registry holds', async () => {
    // The scoreboard reads `systemWhole: true` beside an `area` in the
    // syntax (eslint-rules/admin-counts.mjs); the registry is what runs. A
    // policy whose scope is a shared const, a spread or a helper's answer
    // would count once or not at all there: here the two must agree.
    const whole = [
      ...listBuiltins().map((d) => d.policy),
      ...Object.values(MCP_SURFACE_POLICIES),
    ].filter((p) => policySystemWhole(p));
    expect(whole.length).toBeGreaterThan(0);
    expect((await scoreboard()).systemWholeTools).toBe(whole.length);
  }, 60_000);

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
