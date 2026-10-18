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
  // A folder's description (the seeded item's probe reads the node's data).
  'folder_describe edit branch @root',
  'folder_describe edit branch @folder',
  // A snapshot's delete asks edit of the app: the database refuses it on.
  'app_snapshot_delete edit app @root',
  'app_snapshot_delete edit app @folder',
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
 *  answers "parent folder ... not found". The refusal is right (no row
 *  changes); the answer differs from a random path's, so the folder's
 *  existence shows. Owner's to decide (a lookup that answers a hidden path
 *  as a free one, or the same refusal for both). */
const S11A_1 = 'S11a-1 a hidden folder path shows (file_create makes a free path)';
const HIDDEN_PATH_SHOWS: readonly string[] = ['web-turn turn', 'mcp-oauth login'].flatMap((w) =>
  ['owner', 'admin'].map((r) => `tool:file_create ${w}/${r} create file @folder`),
);

/** The two ways in of a tool cell, by name. */
const WAYS = ['web-turn turn', 'mcp-oauth login'] as const;

/** S11a-3. A member's export lands in the Admin-only auto-filed folder
 *  (files auto-filed.ts), so the member's scope has no parent folder to make
 *  it in ("parent folder 'files' not found"): app_export by a member who
 *  reads the app is refused. sheet_build files its workbook there too (it
 *  declares no item, so it has no cell). Owner's to decide (where a
 *  member's export and built sheet land). */
const S11A_3 = "S11a-3 app_export files a member's export in the Admin-only auto-filed folder";
const MEMBER_EXPORT_REFUSED: readonly string[] = WAYS.map(
  (w) => `tool:app_export ${w}/homeModerator read app @folder`,
);

/** S11a-5. A member's move into a folder of another workspace answers a
 *  database error: after the move, the tree's share follow-up (content
 *  tree/write.ts followShares) reads node_embeds through
 *  mantle_embeds_reached in the caller's scope, and the workspace role may
 *  not read that table (access-matrix.ts: the admin pool only). A bug, not
 *  S11a's to fix (product code). */
const S11A_5 =
  "S11a-5 a member's move to another workspace's folder: followShares reads node_embeds";
const MEMBER_MOVE_ERRORS: readonly string[] = [
  'tool:page_move mcp-oauth login/homeModerator move page @folder',
  'tool:tree_item_move mcp-oauth login/homeModerator move recall @folder',
];

/** S11a-6. A Write grant's member may not set a folder's indexing or rename
 *  it: the database refuses the edit ("not allowed to edit this item"),
 *  where the guide lets a Write grant edit the item. Owner's to decide
 *  (whether a folder's indexing and name are its manager's). */
const S11A_6 = "S11a-6 a Write grant may not set a folder's indexing or rename it";
const FOLDER_EDIT_REFUSED: readonly string[] = WAYS.flatMap((w) => [
  `tool:folder_set_indexing ${w}/writeGrant edit branch @root`,
  `tool:tree_folder_update ${w}/writeGrant edit branch @folder`,
]);

/** S11a-7. app_table_export_set is refused for its app's Moderator: the
 *  export row's write check is `manage` (access-matrix.ts), whose INSERT
 *  branch asks a Moderator of the row's workspace_id (mantle_write_check_trg,
 *  written for grant rows), and app_table_exports has no such column, so no
 *  scoped insert passes (warn reports it, on refuses). A bug since the gap
 *  tables closed (migration 0302), not S11a's to fix (product code). */
const S11A_7 = 'S11a-7 app_table_export_set: the manage check asks a workspace_id the row lacks';
const EXPORT_LINK_REFUSED: readonly string[] = WAYS.map(
  (w) => `tool:app_table_export_set ${w}/homeModerator editDraft app @root`,
);

/** The actor check modes the surface cells run in (docs/update-prod.md:
 *  off, the fleet's default; warn; on). */
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
  ...Object.fromEntries(
    MEMBER_EXPORT_REFUSED.map((name) => [name, known(S11A_3, 'refused, the oracle allows')]),
  ),
  ...Object.fromEntries(
    MEMBER_MOVE_ERRORS.map((name) => [
      name,
      known(S11A_5, 'refused, the oracle allows: Error: the database could not run this request'),
    ]),
  ),
  ...Object.fromEntries(
    FOLDER_EDIT_REFUSED.map((name) => [
      name,
      known(S11A_6, 'You cannot change this item in your workspaces'),
    ]),
  ),
  ...Object.fromEntries(
    EXPORT_LINK_REFUSED.map((name) => [
      name,
      known(S11A_7, [
        'INSERT on app_table_exports: not a Moderator of the workspace',
        'You cannot change this item in your workspaces',
      ]),
    ]),
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
