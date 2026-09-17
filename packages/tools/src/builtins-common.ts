/**
 * Builtins: helpers shared by the split builtins files (id-shape preconditions, strArr).
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { type ToolPrecondition } from './types';

/**
 * Intentionally NOT the shared `strArrOpt` from './coerce': this variant also
 * drops empty-string members (`s.length > 0`), which `strArrOpt` deliberately
 * preserves. Kept local so that empty-dropping semantic stays with its one
 * call site (`relations`) rather than silently changing the shared contract.
 */
export function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return out.length > 0 ? out : undefined;
}

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING node the owner holds.
// Folders are `type='branch'` nodes; the "any node" variant leaves nodeType
// unset so universal readers keep working across every kind.
export const NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'node_id', lookup: 'search_nodes / tree_list' },
];

export const FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];

export const FOLDER_ID_PRE: readonly ToolPrecondition[] = [
  {
    kind: 'node_exists',
    param: 'folder_id',
    nodeType: 'branch',
    lookup: 'folder_list / tree_list',
  },
];

// ─── search / tree ────────────────────────────────────────────────────────
