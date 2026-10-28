import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/runtime/assistant', () => ({
  runSimulatedResponderTurn: vi.fn(),
  describeResponderPersona: vi.fn(),
}));

import { BUILTIN_TOOLS, MCP_SURFACE_POLICIES, type ToolPolicy } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import type { ToolHints } from './tool-annotations';

/**
 * The hints the real registration emits, for every tool of the owner MCP
 * surface (register/surface.test.ts pins the names; this pins the hints).
 *
 * The one rule that must hold: a tool says read-only exactly when its
 * declared policy says `read`. A client offers "Always allow" on a
 * read-only tool, so a write marked read-only would run without a prompt.
 *
 * The destructive, idempotent and open-world sets are pinned by name
 * here, in the test only: the facts live on each tool's policy
 * (tool-policy.ts `destructive`, `idempotent`, `outside`), and a change
 * there shows up as a diff of these lists.
 */

type Registered = { name: string; hints: ToolHints | undefined };

/** Register onto a capturing fake; the SDK server is not needed here. */
function surface(transport: 'stdio' | 'http'): Registered[] {
  const out: Registered[] = [];
  const server = {
    registerTool: (name: string, config: { annotations?: ToolHints }) =>
      void out.push({ name, hints: config.annotations }),
  };
  registerMantleTools(server as never, 'owner-1', { transport });
  return out;
}

/** The declared policy of a registered name: a definition's, else the
 *  builtin's (the same precedence as mcp-policy.ts mcpToolPolicyOf). */
const POLICY = new Map<string, ToolPolicy>();
for (const def of BUILTIN_TOOLS) POLICY.set(def.slug, def.policy);
for (const [slug, policy] of Object.entries(MCP_SURFACE_POLICIES)) POLICY.set(slug, policy);

describe('MCP tool hints on the surface', () => {
  const stdio = surface('stdio');
  const names = (pick: (r: Registered) => boolean | undefined) =>
    stdio
      .filter((r) => pick(r) === true)
      .map((r) => r.name)
      .sort();

  it('every registered tool carries hints with its slug as the title', () => {
    for (const { name, hints } of stdio) {
      expect(hints, name).toBeDefined();
      expect(hints?.title, name).toBe(name);
    }
  });

  it('every effect:read tool says read-only and no effect:write tool does', () => {
    expect(stdio.length).toBeGreaterThan(200);
    for (const { name, hints } of stdio) {
      const effect = POLICY.get(name)?.effect;
      expect(effect, `${name} has a declared policy`).toBeDefined();
      expect(hints?.readOnlyHint, name).toBe(effect === 'read');
    }
  });

  it('a read is never destructive and always idempotent', () => {
    for (const { name, hints } of stdio) {
      if (POLICY.get(name)?.effect !== 'read') continue;
      expect(hints?.destructiveHint, name).toBe(false);
      expect(hints?.idempotentHint, name).toBe(true);
    }
  });

  it('destructive and idempotent are declared on writes only', () => {
    for (const def of BUILTIN_TOOLS) {
      if (def.policy.destructive || def.policy.idempotent) {
        expect(def.policy.effect, def.slug).toBe('write');
      }
    }
  });

  it('the same hints over http (minus run_terminal)', () => {
    const byName = new Map(stdio.map((r) => [r.name, r.hints]));
    for (const { name, hints } of surface('http')) expect(hints, name).toEqual(byName.get(name));
  });

  it('pins the open-world tools', () => {
    expect(names((r) => r.hints?.openWorldHint)).toEqual([
      'email_page',
      'email_send',
      'peer_call',
      'peer_file_copy',
      'peer_list',
      'peer_node_get',
      'peer_query',
      'peer_search_chunks',
      'peer_tools',
      'telegram_send',
      'web_crawl',
      'web_fetch',
      'web_map',
      'web_search',
      'web_search_pro',
    ]);
  });

  it('pins the destructive tools', () => {
    expect(names((r) => r.hints?.destructiveHint)).toEqual([
      'api_tool_delete',
      'app_data_write',
      'app_db_schema_set',
      'app_snapshot_delete',
      'contact_delete',
      'event_delete',
      'file_create',
      'file_delete',
      'file_upload',
      'formula_delete',
      'journal_delete',
      'note_delete',
      'page_delete',
      'page_discard_draft',
      'present_delete',
      'recall_map_delete',
      'run_terminal',
      'sandbox_exec',
      'sandbox_rm',
      'table_delete',
      'table_snapshot_delete',
      'task_delete',
    ]);
  });

  it('pins the idempotent writes', () => {
    expect(names((r) => !r.hints?.readOnlyHint && r.hints?.idempotentHint)).toEqual([
      'api_docs_set',
      'api_skill_set',
      'app_source_set',
      'app_table_export_set',
      'app_tools_set',
      'file_create',
      'file_upload',
      'messenger_mark_read',
      'model_pool_set',
      'node_unshare',
      'page_discard_draft',
      'page_unshare',
      'recall_card_put',
      'sandbox_autostart',
      'set_timezone',
      'table_cell_set',
      'table_rows_upsert',
      'telegram_mark_processed',
      'tool_group_ensure',
      'worker_group_ensure',
    ]);
  });
});
