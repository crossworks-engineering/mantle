/**
 * `mcpOnly` builtins: on the MCP surface, off every agent's.
 *
 * These are the owner's own operator controls — the approval queue, the runner
 * panels, the Telegram inbox. Before tier 3 of the 2026-09-02 audit they were
 * hand-written `server.tool(...)` calls, which is why they had no test at all.
 * Promoting them to builtins gave them one implementation; the risk that
 * created is the opposite one — a builtin is the thing agents get granted, and
 * an agent holding `pending_approve` would approve its own gated call, which is
 * precisely the gate the pending row exists to impose.
 *
 * So this pins BOTH halves: every mcpOnly def is registered on the MCP surface,
 * and none of them is seedable or nameable by a manifest tool group.
 */

import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, listSeedableBuiltins } from '@mantle/tools';

import { registerMantleTools } from './build-server';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function registeredSlugs(): Set<string> {
  const out = new Set<string>();
  const fakeServer = {
    registerTool: (name: string, _config: unknown, _h: Handler) => {
      out.add(name);
    },
  };
  registerMantleTools(fakeServer as never, 'owner-1', { transport: 'stdio' });
  return out;
}

const MCP_ONLY = BUILTIN_TOOLS.filter((t) => t.mcpOnly)
  .map((t) => t.slug)
  .sort();

describe('mcpOnly builtins', () => {
  it('is exactly the owner-operator set — a new entry is a deliberate act', () => {
    expect(MCP_ONLY).toEqual(
      [
        // The vault's writes (vault v2 part 1): an owner's client puts a
        // secret in; no agent is granted a vault write.
        'api_key_delete',
        'api_key_import',
        'api_key_set',
        'api_key_test',
        'app_authoring_guide',
        'file_delete',
        'file_upload',
        'folder_create',
        'folder_delete',
        // The messenger (Messenger V1): every login's chats, MCP only until
        // the agent tool group of Phase 6.
        'messenger_create',
        'messenger_directory',
        'messenger_list',
        'messenger_mark_read',
        'messenger_open',
        'messenger_send',
        'messenger_wait',
        'note_delete',
        'pending_approve',
        'pending_get',
        'pending_list',
        'pending_reject',
        'recall_card_set_slug',
        'recall_cards_reorder',
        'recall_map_delete',
        'recall_map_get',
        'recall_map_publish',
        'recall_map_set_slug',
        'recall_pending',
        'recall_prompt_confirm',
        'recall_revision_restore',
        'recall_revisions',
        'telegram_edit',
        'telegram_mark_processed',
        'telegram_pair',
        'telegram_pending',
        'telegram_react',
        'tree_folder_delete',
        'worker_group_ensure',
        'worker_group_list',
        'workspaces_list',
      ].sort(),
    );
  });

  it('every one of them is registered on the MCP surface', () => {
    const registered = registeredSlugs();
    const missing = MCP_ONLY.filter((slug) => !registered.has(slug));
    expect(missing, `mcpOnly builtins absent from the MCP surface: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it("none of them is seeded into the owner's tools table", () => {
    const seeded = new Set(listSeedableBuiltins().map((d) => d.slug));
    const leaked = MCP_ONLY.filter((slug) => seeded.has(slug));
    expect(leaked, `mcpOnly builtins that would be seeded: ${leaked.join(', ')}`).toEqual([]);
  });

  // The other half of the invariant — that no manifest tool group can NAME one
  // of these — is pinned where the manifest lives:
  // server/web/lib/system-manifest/manifest.test.ts.
});
