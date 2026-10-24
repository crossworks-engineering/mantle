/**
 * The A8 cells that fail today (the database, or a way in, gives another
 * answer than the guide), each a finding for the owner to decide: the cell's
 * name (a8-grid.ts cellName; a surface cell's name starts with its surface),
 * the finding it belongs to, and a piece of the reason it fails with. A
 * listed cell is known only while it fails for that reason: one that fails
 * for another reason fails the run like an unlisted one. A8 is test code
 * only: a finding is never fixed here. The grid and the surface cells fail
 * on a failure not listed, and on a listed one that passes (the list only
 * shrinks). docs/actors.md, "A8 matrix", names each finding.
 */
// F4 (an Admin user's write request on the system pool, its edits not held
// to its scope: the `login@system` cells, an edit, a link, a draft edit and
// an app's data write of an item outside the user's workspaces made) left
// the list with F4 (docs/actors.md, "Admin writes on the write role (F4)"):
// the session guard enters an Admin user's write request in its scope, its
// reads and its writes, and the write runs on the write role, where the
// database refuses each such write. Its cells are the `login@request` cells
// now, and pass.

/** P1. Below on (an emergency since the pre-check removal: the checks'
 *  floor, migration 0301, docs/actors.md "Pre-check deletion"): a tool's
 *  edit of an item the scope reads and may not change is made, because its
 *  TypeScript item pre-check went and the database refuses it only with
 *  the checks on (warn logs it as a miss, off makes it silently). The same
 *  cells pass in `on`, the only mode a box runs in on this release. */
const P1 = 'P1 below on: a tool edit the database refuses only when on';

/** The surface cells P1 fails (the pairwise pick is stable: a8-grid.ts),
 *  in off and in warn. `pending turn/readGrant edit task @root` left the
 *  list in the R0 fix round (L2): a call that waits for approval on an item
 *  its scope may not change is refused before it is queued, in every mode,
 *  as the oracle answers. */
const BELOW_ON_TOOL_EDITS: readonly string[] = [
  'peer login/readGrant edit formula @folder',
  'recipe turn/readGrant edit formula @root',
  'recipe turn/readGrant edit note @folder',
  'recipe turn/readGrant edit note @root',
  'team-turn turn/readGrant edit note @folder',
  'team-turn turn/readGrant edit task @folder',
  'team-turn turn/readGrant edit task @root',
  'web-turn turn/readGrant edit note @folder',
];

/** The tool cells (S11a, a8-tool-cells.matrix.test.ts) P1 fails in warn,
 *  where both checks report and refuse nothing: the read grant's member's
 *  edit through a turn and over MCP is made. The same cells pass in `on`. */
const BELOW_ON_TOOL_CELLS: readonly string[] = [
  'formula_update edit formula @root',
  'recall_map_update edit recall @root',
  'recall_card_delete edit recall @root',
  'recall_card_put edit recall @root',
  'task_update edit task @root',
  'note_update edit note @root',
  'event_update edit event @root',
  'page_update edit page @root',
  'table_update edit table @root',
  'present_update edit present @root',
  // A folder's description (the seeded item's probe reads the node's data).
  'folder_describe edit branch @root',
  'folder_describe edit branch @folder',
].flatMap((c) => {
  const [tool, ...rest] = c.split(' ');
  return [
    `tool:${tool} web-turn turn/readGrant ${rest.join(' ')}`,
    `tool:${tool} mcp-oauth login/readGrant ${rest.join(' ')}`,
  ];
});

/** S11a-1. A hidden folder path shows to an Admin user: file_create makes
 *  the missing folders of its path (makesFolders), so a free path is made
 *  and answered ok while the path of a folder the caller does not read
 *  answers "parent folder ... not found" (no row changes, but the folder's
 *  existence shows). The owner accepted it as a known limit (2026-10-18);
 *  the folder trail (migration 0311) is for a login's own session and
 *  leaves the tools as they were, so it stays. */
const S11A_1 = 'S11a-1 a hidden folder path shows (file_create makes a free path)';
const HIDDEN_PATH_SHOWS: readonly string[] = ['web-turn turn', 'mcp-oauth login'].flatMap((w) =>
  ['owner', 'admin'].map((r) => `tool:file_create ${w}/${r} create file @folder`),
);

// S11a-5 and S11a-6a left the list in the tree bugs fix (migration 0305,
// docs/_archive/tree-bugs-handover.md), each now a rule its tool's matrix
// declares and its cells pass as: a member's move into a folder of another
// workspace runs the share follow-up (content tree/write.ts followShares)
// as the named system step 'tree-refold', not in the caller's scope, which
// may not read node_embeds; a Write grant's member renames the folder
// (tree_folder_update), the owner's rule (2026-10-18), its move, indexing,
// delete and grants staying manage.
//
// S11a-3, S11a-7 and S11a-8 left the list on the rebase on v0.300.90, each
// now a rule its tool's matrix declares and its cells pass as: a member's
// export lands where the member can see it (files export-home.ts, the
// member export), so app_export by a member who reads the app is allowed;
// app_table_export_set is its app's managers' in every check mode
// (migration 0303); process_extraction asks edit of the item (its itemArgs),
// so the read grant's member is refused.

/** The actor check modes the surface cells run in (docs/update-prod.md):
 *  off, warn and on. The fleet runs on (the actor and the edit check
 *  both); off and warn stay for a box that lowers them. */
export type CheckMode = 'off' | 'warn' | 'on';
export const CHECK_MODES: readonly CheckMode[] = ['off', 'warn', 'on'];

export type KnownFailure = {
  /** The finding (F1, F2, ...). */
  finding: string;
  /** A piece of the cell's failure reason, as the run prints it (or one of
   *  several: a cell that fails in another words in each mode). */
  reason: string | readonly string[];
  /** A surface cell: the modes it fails in (all three when not given). */
  modes?: readonly CheckMode[];
};

const known = (
  finding: string,
  reason: string | readonly string[],
  modes?: readonly CheckMode[],
): KnownFailure => (modes ? { finding, reason, modes } : { finding, reason });

export const KNOWN_FAILURES: Readonly<Record<string, KnownFailure>> = {
  // The tool cells (S11a): P1 in warn, the findings in both modes.
  ...Object.fromEntries(
    BELOW_ON_TOOL_CELLS.map((name) => [name, known(P1, 'changed, the oracle denies', ['warn'])]),
  ),
  ...Object.fromEntries(
    HIDDEN_PATH_SHOWS.map((name) => [name, known(S11A_1, "not a random uuid's answer")]),
  ),
  // The grid (SQL): none since F4.
  // The surface cells (all three check modes unless named).
  ...Object.fromEntries(
    BELOW_ON_TOOL_EDITS.map((name) => [
      name,
      known(P1, 'changed, the oracle denies', ['off', 'warn']),
    ]),
  ),
};

/**
 * A run's failures against the list: `grid` the SQL grid's cells (a name
 * whose first word holds a '/'), else the surface cells' in check `mode`,
 * or with `tools` the tool cells' (a name that starts `tool:`, S11a).
 * `unexpected`: a failure not listed (for this mode), or listed for another
 * reason (both fail the run); `fixed`: a listed cell that did not fail
 * (take it off the list, or off this mode).
 */
export function sortFailures(
  failures: ReadonlyMap<string, string>,
  grid: boolean,
  mode?: CheckMode,
  tools = false,
): { unexpected: string[]; fixed: string[] } {
  const ours = (name: string) =>
    name.split(' ')[0]!.includes('/') === grid &&
    name.startsWith('tool:') === tools &&
    (grid || !mode || !KNOWN_FAILURES[name]?.modes || KNOWN_FAILURES[name]!.modes!.includes(mode));
  const unexpected: string[] = [];
  for (const [name, why] of failures) {
    const k = KNOWN_FAILURES[name];
    if (!k || !ours(name)) unexpected.push(`${name}: ${why}`);
    else if (!(typeof k.reason === 'string' ? [k.reason] : k.reason).some((r) => why.includes(r))) {
      unexpected.push(
        `${name}: listed (${k.finding}) for "${String(k.reason)}", fails with: ${why}`,
      );
    }
  }
  const fixed = Object.keys(KNOWN_FAILURES).filter((n) => ours(n) && !failures.has(n));
  if (mode) return { unexpected, fixed: fixed.map((n) => `${n} (check ${mode})`) };
  return { unexpected, fixed };
}
