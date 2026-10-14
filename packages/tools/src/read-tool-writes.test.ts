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
 * The sweep (a read-only audit of every read builtin and MCP definition,
 * their handlers and what they call) found the writes below. Each is pinned
 * here with its table; a write to an item table must be named or fixed
 * before an entry that reaches it runs through the gate.
 *
 * Found, and how each is handled:
 *
 *  - The three app data reads (app_data_schema, app_data_query) provision
 *    the app's registry row, apply a newer schema and set the viewer salt
 *    (app_databases, an item table). They run only on a login's own MCP
 *    connection (appDataCaller), which reaches the gate in A5 step 4, not
 *    on a turn, a run or a pending call: step 4 must name or move them
 *    (MCP_ONLY_ITEM_WRITES).
 *  - Every other write is to a table that is no item table, so it runs as
 *    before (SIDE_WRITES): sandbox_mcp_tools's last-used touch (sandboxes;
 *    prerequisite 0a: nothing breaks, so the tool stays a read and the touch
 *    stays as it is), the app access log, a peer's last contact, the
 *    embedding cache and its failover stamp, a worker's usage, an API key's
 *    last use, a tool result's chunks, and every call's trace.
 *  - The page reads' block ids and recall_match's prompt embeddings are
 *    named read-path writes already (backfill:page-block-ids,
 *    backfill:recall-prompt-embeddings).
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

/** Writes of read tools to tables that are no item table: they run as
 *  before under a read-only actor. */
const SIDE_WRITES: readonly { tools: readonly string[]; table: string; where: string }[] = [
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
    tools: ['peer_query', 'peer_search_chunks', 'peer_node_get', 'peer_tools'],
    table: 'mantle_peers',
    where: 'packages/content/src/peers/registry.ts (markPeerContacted)',
  },
  {
    tools: ['search_nodes', 'search_chunks', 'recall_match', 'find_window', 'read_result'],
    table: 'embedding_cache',
    where: 'packages/embeddings/src/index.ts (embed: the cache, the failover stamp)',
  },
  {
    tools: ['search_chunks'],
    table: 'ai_workers',
    where: 'packages/decisions/src/decide.ts (bumpWorkerUsage)',
  },
  {
    tools: ['extract_from_image', 'summarize_text'],
    table: 'api_keys',
    where: 'packages/api-keys/src/index.ts (last_used)',
  },
  {
    tools: ['read_result'],
    table: 'tool_result_chunks',
    where: 'packages/tools/src/tool-results.ts (ensureResultChunked)',
  },
];

/** Writes of read tools to an item table, on an entry that reaches the
 *  gate only in A5 step 4 (the login's own MCP connection). */
const MCP_ONLY_ITEM_WRITES: readonly { tools: readonly string[]; table: string; where: string }[] =
  [
    {
      tools: ['app_data_schema', 'app_data_query'],
      table: 'app_databases',
      where:
        'packages/content/src/app-broker.ts (ensureRegistry, applySchema) and app-viewer.ts (appViewerSalt)',
    },
  ];

describe('the writes inside read tools (A5 step 3a)', () => {
  const items = itemTables();
  const byName = new Map(BUILTIN_TOOLS.map((d) => [d.slug, d]));

  it('reads the item tables (not vacuous)', () => {
    for (const t of ['nodes', 'pages', 'app_databases', 'content_chunks']) {
      expect(items.has(t), t).toBe(true);
    }
  });

  it('every listed tool is a read builtin', () => {
    for (const w of [...SIDE_WRITES, ...MCP_ONLY_ITEM_WRITES]) {
      for (const slug of w.tools) {
        expect(byName.get(slug)?.policy.effect, slug).toBe('read');
      }
    }
  });

  it('a side write touches no item table: it runs as before under a read-only actor', () => {
    for (const w of SIDE_WRITES) expect(items.has(w.table), w.table).toBe(false);
  });

  it('an item table write is reached only over MCP, which the gate takes in step 4', () => {
    for (const w of MCP_ONLY_ITEM_WRITES) {
      expect(items.has(w.table), w.table).toBe(true);
      for (const slug of w.tools) {
        expect(slug.startsWith('app_data_'), slug).toBe(true);
      }
    }
    // The gated entries of step 3a name no MCP channel: a turn, a run item,
    // a pending approval (their surfaces), so the tools answer before any
    // write.
    const surfaces: NonNullable<ToolHandlerContext['surface']>[] = [
      { kind: 'web', loginId: '55555555-5555-4555-8555-555555555555' },
      { kind: 'team', loginId: '55555555-5555-4555-8555-555555555555' },
      { kind: 'owner', via: 'run', loginId: '55555555-5555-4555-8555-555555555555' },
      { kind: 'owner', via: 'pending', loginId: '55555555-5555-4555-8555-555555555555' },
    ];
    for (const surface of surfaces) {
      expect(appDataCaller({ ownerId: 'o', surface }), JSON.stringify(surface)).toBeNull();
    }
  });

  it('the named read-path writes stay named', () => {
    for (const name of ['backfill:page-block-ids', 'backfill:recall-prompt-embeddings']) {
      expect(name in READ_PATH_WRITES, name).toBe(true);
    }
  });
});
