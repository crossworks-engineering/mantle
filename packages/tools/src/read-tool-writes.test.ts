/**
 * The writes inside read tools (workspaces arch A5 step 3a; plan 4.4). Since
 * step 3a a read tool called through the gate runs read only (callActor:
 * login(ro); system work it starts stays read only, systemUnder), and the
 * database refuses a read-only actor's change of an ITEM table (0280's
 * statement trigger, on the tables of the actor check, 0275) when the edit
 * check is on. A read tool's write is fine when it is a named read-path
 * write (READ_PATH_WRITES: it runs as its own system actor) or touches a
 * table that is no item table.
 *
 * The tool set is the policy table's: every builtin whose policy says
 * `effect: 'read'` must be classified below, so a read builtin added
 * without a look at its writes fails here (low round, LOW-4). The lists
 * come from the step 3a sweep (a read-only audit of every read builtin and
 * MCP definition, their handlers and what they call) and its audit slice;
 * this is a SOURCE classification, not proof. The one item table write
 * found (the app data reads' provisioning) runs on a real database in
 * server/web/server/a5-app-data-read-only.db.test.ts; each other read
 * builtin run read only with the edit check on is carried to the A8 matrix
 * (docs/actors.md, "Step 4 must-dos").
 *
 * Found, and how each is handled:
 *
 *  - The app data reads app_data_schema and app_data_query provision the
 *    app's registry row, apply a newer schema and set the viewer salt
 *    (app_databases, an item table). They run only on a login's own MCP
 *    connection (appDataCaller), which runs through the gate since A5
 *    step 4: the provisioning is a named read-path write there
 *    ('repair:app-db', NAMED_READ_PATH; builtins-app-data.readpath.test.ts
 *    pins the actor it runs as under a read-only login).
 *  - Every other write is to a table that is no item table, so it runs as
 *    before (SIDE_WRITES). Two are uncaught: a failure fails the call
 *    (read_result's chunking). The peer reads' last-contact stamp is
 *    best-effort since the low round (a refused write is skipped, as
 *    verifyInboundToken's last-seen stamp).
 *  - The page reads' block ids and recall_match's prompt embeddings are
 *    named read-path writes already (NAMED_READ_PATH).
 *  - Every other read builtin: the sweep found no write but the call's
 *    trace (NO_WRITE_FOUND).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { READ_PATH_WRITES } from '@mantle/db';
import { BUILTIN_TOOLS } from './index';
import { appDataCaller } from './builtins-app-data';
import type { ToolHandlerContext } from './types';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The item tables: the tables of the actor check (0275), which 0280's
 *  read-only refusal covers (all but node_acl_head: a heads lock). */
function itemTables(): Set<string> {
  const sql = readFileSync(join(repoRoot, 'packages/db/migrations/0275_actor_check.sql'), 'utf8');
  const list = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]/.exec(sql)?.[1] ?? '';
  const tables = new Set([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
  tables.delete('node_acl_head');
  return tables;
}

/** The read builtins that embed a query (embed, @mantle/embeddings). */
const EMBEDDING_READS = [
  'search_nodes',
  'search_chunks',
  'recall_match',
  'find_window',
  'read_result',
] as const;

/** A write of read tools to a table that is no item table: it runs as
 *  before under a read-only actor. `uncaught`: a failure fails the call. */
type SideWrite = { tools: readonly string[]; table: string; where: string; uncaught?: true };

/** Writes of read tools to tables that are no item table. */
const SIDE_WRITES: readonly SideWrite[] = [
  {
    tools: ['sandbox_mcp_tools'],
    table: 'sandboxes',
    where: 'packages/tools/src/sandbox/mcp.ts (touchSandbox)',
  },
  {
    tools: ['app_data_list', 'app_data_schema', 'app_data_query'],
    table: 'app_access_log',
    where: 'packages/content/src/app-access-log.ts (recordAppAccess, recordAppError)',
  },
  {
    // Best-effort since the low round: a refused write is skipped.
    tools: ['peer_query', 'peer_search_chunks', 'peer_node_get', 'peer_tools'],
    table: 'mantle_peers',
    where: 'packages/content/src/peers/registry.ts (markPeerContacted)',
  },
  {
    tools: EMBEDDING_READS,
    table: 'embedding_cache',
    where: 'packages/embeddings/src/index.ts (embed: the cache)',
  },
  {
    tools: EMBEDDING_READS,
    table: 'embedding_config',
    where: 'packages/embeddings/src/index.ts (embed: the failover stamp)',
  },
  {
    tools: EMBEDDING_READS,
    table: 'provider_alerts',
    where: 'packages/embeddings/src/provider-outage.ts (recordProviderFailure)',
  },
  {
    tools: [...EMBEDDING_READS, 'extract_from_image', 'summarize_text'],
    table: 'api_keys',
    where: 'packages/api-keys/src/index.ts (getApiKey: last_used)',
  },
  {
    tools: ['search_chunks'],
    table: 'ai_workers',
    where: 'packages/decisions/src/decide.ts (bumpWorkerUsage)',
  },
  {
    tools: ['read_result'],
    table: 'tool_results',
    where: 'packages/tools/src/tool-results.ts (ensureResultChunked: the chunked flag)',
    uncaught: true,
  },
  {
    tools: ['read_result'],
    table: 'tool_result_chunks',
    where: 'packages/tools/src/tool-results.ts (ensureResultChunked)',
    uncaught: true,
  },
];

/** Read builtins whose write is a named read-path write (READ_PATH_WRITES):
 *  it runs as its own system actor, whoever reads. */
const NAMED_READ_PATH: readonly { tools: readonly string[]; name: string }[] = [
  {
    tools: ['page_get', 'page_blocks_list', 'page_block_get'],
    name: 'backfill:page-block-ids',
  },
  { tools: ['recall_match'], name: 'backfill:recall-prompt-embeddings' },
  // A5 step 4: the app data reads' provisioning (app_databases).
  { tools: ['app_data_schema', 'app_data_query'], name: 'repair:app-db' },
];

/** Read builtins where the sweep found no write but the call's trace. */
const NO_WRITE_FOUND: readonly string[] = [
  'access_get',
  'agent_list',
  'api_docs_get',
  'api_key_refs',
  'api_tool_get',
  'api_tool_list',
  'app_authoring_guide',
  'app_db_list',
  'app_db_query',
  'app_deleted_list',
  'app_errors',
  'app_get',
  'app_list',
  'app_snapshot_list',
  'brain_capacity',
  'calculate',
  'contact_find',
  'contact_get',
  'contact_list',
  'diagram_guide',
  'diagram_types',
  'draw_get',
  'draw_list',
  'email_get',
  'email_list',
  'entity_facts',
  'entity_mentions',
  'entity_neighbors',
  'entity_search',
  'event_get',
  'event_list',
  'file_get',
  'file_list',
  'file_read',
  'folder_get_by_path',
  'folder_list',
  'formula_evaluate',
  'formula_get',
  'formula_list',
  'graph_path',
  'journal_get',
  'journal_list',
  'location_distance',
  'location_nearby',
  'node_read',
  'note_get',
  'note_list',
  'page_list',
  'peer_list',
  'pending_get',
  'pending_list',
  'read_section',
  'recall_go',
  'recall_index',
  'recall_map_get',
  'recall_open',
  'recall_pending',
  'recall_revisions',
  'replay_window',
  'run_state',
  'sandbox_list',
  'sandbox_ls',
  'table_aggregate',
  'table_get',
  'table_history',
  'table_list',
  'table_query',
  'table_row_get',
  'table_rows_list',
  'table_schema',
  'table_sql',
  'task_get',
  'task_list',
  'telegram_pending',
  'tool_catalog',
  'tool_group_list',
  'tree_folders',
  'tree_list',
  'worker_group_list',
  'workspaces_list',
];

/** Every read builtin the lists above classify. */
function classified(): Set<string> {
  return new Set([
    ...SIDE_WRITES.flatMap((w) => w.tools),
    ...NAMED_READ_PATH.flatMap((w) => w.tools),
    ...NO_WRITE_FOUND,
  ]);
}

describe('the writes inside read tools (A5 step 3a)', () => {
  const items = itemTables();
  const byName = new Map(BUILTIN_TOOLS.map((d) => [d.slug, d]));

  it('reads the item tables (not vacuous)', () => {
    for (const t of ['nodes', 'pages', 'app_databases', 'content_chunks']) {
      expect(items.has(t), t).toBe(true);
    }
  });

  it('every listed tool is a read builtin', () => {
    for (const slug of classified()) {
      expect(byName.get(slug)?.policy.effect, slug).toBe('read');
    }
  });

  it('classifies every read builtin of the policy table (a new one fails here)', () => {
    const known = classified();
    const reads = BUILTIN_TOOLS.filter((d) => d.policy.effect === 'read').map((d) => d.slug);
    expect(reads.length).toBeGreaterThan(50);
    const unclassified = reads.filter((slug) => !known.has(slug));
    expect(
      unclassified,
      'a read builtin with no look at its writes: add it to a list above',
    ).toEqual([]);
    // No write found means no write listed for it.
    const listed = new Set([...known].filter((s) => !NO_WRITE_FOUND.includes(s)));
    for (const slug of NO_WRITE_FOUND) expect(listed.has(slug), slug).toBe(false);
  });

  it('a side write touches no item table: it runs as before under a read-only actor', () => {
    for (const w of SIDE_WRITES) expect(items.has(w.table), w.table).toBe(false);
  });

  it('the app data reads that provision name it, on the only entry that reaches them', () => {
    // The gated entries of step 3a name no MCP channel: a turn, a run item,
    // a pending approval (their surfaces), so the tools answer before any
    // write; on the login's own MCP (A5 step 4) the provisioning is named.
    const surfaces: NonNullable<ToolHandlerContext['surface']>[] = [
      { kind: 'web', loginId: '55555555-5555-4555-8555-555555555555' },
      { kind: 'team', loginId: '55555555-5555-4555-8555-555555555555' },
      { kind: 'owner', via: 'run', loginId: '55555555-5555-4555-8555-555555555555' },
      { kind: 'owner', via: 'pending', loginId: '55555555-5555-4555-8555-555555555555' },
    ];
    for (const surface of surfaces) {
      expect(appDataCaller({ ownerId: 'o', surface }), JSON.stringify(surface)).toBeNull();
    }
    expect(items.has('app_databases')).toBe(true);
    const named = NAMED_READ_PATH.find((w) => w.name === 'repair:app-db');
    expect(named?.tools).toEqual(['app_data_schema', 'app_data_query']);
  });

  it('the named read-path writes stay named', () => {
    for (const { name } of NAMED_READ_PATH) {
      expect(name in READ_PATH_WRITES, name).toBe(true);
    }
  });

  it('the uncaught side writes are to no item table (a failure fails only the call)', () => {
    const uncaught = SIDE_WRITES.filter((w) => w.uncaught);
    expect(uncaught.map((w) => w.table).sort()).toEqual(['tool_result_chunks', 'tool_results']);
    for (const w of uncaught) expect(items.has(w.table), w.table).toBe(false);
  });
});
