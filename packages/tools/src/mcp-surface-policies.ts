/**
 * The policies of the hand-written MCP tools (workspaces arch plan v2,
 * sections 8 and 23.3; A5 step 2 fix round 1, LOW-1). Their definitions
 * (name, group, schema, body) are @mantle/mcp-core mcp-defs.ts, and each
 * takes its policy from here by its name: one policy per tool, declared
 * once, as on a builtin.
 *
 * Here and not in mcp-core: tool-policy.ts loads this table as the surface
 * table in EVERY process, so a view that names a hand-written tool answers
 * the same with or without the MCP surface loaded (ADMIN_ONLY_TOOL_SLUGS
 * holds the two responder writes in server/api too, as it did before A5).
 * A leaf: type imports only, so tool-policy.ts imports it with no cycle.
 *
 * Eleven share a builtin's name and carry that builtin's policy (mcp-core
 * mcp-defs.test.ts pins it; a view reads the builtin's for that name). The
 * other five are MCP's own: `search` (the surface's name for search_nodes)
 * and the four responder tools.
 */
import type { ToolPolicy } from './tool-policy';

const POLICIES = {
  // ── search ──
  tree_list: { effect: 'read', spends: 'none', scope: 'any' },
  search: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'search' },
  // ── files and folders ──
  folder_describe: {
    effect: 'write',
    spends: 'none',
    scope: 'any',
    items: [{ param: 'folder_id', need: 'edit' }],
    keyArea: 'files',
  },
  folder_rename: {
    effect: 'write',
    spends: 'none',
    scope: 'any',
    items: [{ param: 'folder_id', need: 'edit' }],
    keyArea: 'files',
  },
  file_read: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'files' },
  file_get: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'files' },
  file_rename: {
    effect: 'write',
    spends: 'none',
    scope: 'any',
    items: [{ param: 'file_id', need: 'edit' }],
    keyArea: 'files',
  },
  // ── pages ──
  page_list: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'pages', keyEmail: true },
  page_get: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'pages' },
  // ── tables (read only) ──
  table_list: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'tables', keyEmail: true },
  table_get: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'tables' },
  table_rows_list: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'tables' },
  // ── responder ──
  // A turn of the responder, on the owner's keys; it writes into the owner's
  // tools' world (its tools execute), so a key or a peer needs it named.
  ask_responder: {
    effect: 'write',
    spends: 'ownerKey',
    startsModelWork: true,
    scope: 'any',
    peerRisky: true,
  },
  ask_as_responder: { effect: 'write', spends: 'ownerKey', scope: 'any', peerRisky: true },
  // It reads the owner's conversation and writes a trace: Admin only.
  responder_turn_input: { effect: 'write', spends: 'none', scope: 'admin', peerRisky: true },
  // Writes into the owner's conversation as one of their agents: Admin only.
  responder_turn_record: { effect: 'write', spends: 'none', scope: 'admin', peerRisky: true },
} satisfies Record<string, ToolPolicy>;

for (const p of Object.values(POLICIES) as ToolPolicy[]) {
  if (Array.isArray(p.items)) {
    p.items.forEach((t) => Object.freeze(t));
    Object.freeze(p.items);
  }
  Object.freeze(p);
}

/** The name of a hand-written MCP tool. */
export type McpSurfaceSlug = keyof typeof POLICIES;

/** Each hand-written MCP tool's policy, by its name (frozen). */
export const MCP_SURFACE_POLICIES: Readonly<Record<McpSurfaceSlug, ToolPolicy>> =
  Object.freeze(POLICIES);
