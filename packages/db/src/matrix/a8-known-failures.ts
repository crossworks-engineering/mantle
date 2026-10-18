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

/** The tool cells (S11a, a8-tool-cells.matrix.test.ts) P1 fails in warn:
 *  the read grant's member's edit through a turn and over MCP is made. The
 *  same cells pass in `on`. */
const BELOW_ON_TOOL_CELLS: readonly string[] = [
  'tool:formula_update web-turn turn/readGrant edit formula @root',
  'tool:formula_update mcp-oauth login/readGrant edit formula @root',
  'tool:recall_map_update web-turn turn/readGrant edit recall @root',
  'tool:recall_map_update mcp-oauth login/readGrant edit recall @root',
  'tool:recall_card_delete web-turn turn/readGrant edit recall @root',
  'tool:recall_card_delete mcp-oauth login/readGrant edit recall @root',
  'tool:recall_card_put web-turn turn/readGrant edit recall @root',
  'tool:recall_card_put mcp-oauth login/readGrant edit recall @root',
  'tool:task_update web-turn turn/readGrant edit task @root',
  'tool:task_update mcp-oauth login/readGrant edit task @root',
  'tool:note_update web-turn turn/readGrant edit note @root',
  'tool:note_update mcp-oauth login/readGrant edit note @root',
  'tool:event_update web-turn turn/readGrant edit event @root',
  'tool:event_update mcp-oauth login/readGrant edit event @root',
  'tool:page_update web-turn turn/readGrant edit page @root',
  'tool:page_update mcp-oauth login/readGrant edit page @root',
  'tool:table_update web-turn turn/readGrant edit table @root',
  'tool:table_update mcp-oauth login/readGrant edit table @root',
];
const BELOW_ON_TOOL_CELLS_FOLDER: readonly string[] = [
  'tool:note_update web-turn turn/readGrant edit note @folder',
  'tool:note_update mcp-oauth login/readGrant edit note @folder',
];
/** folder_describe writes a folder's description: below on it is made (P1,
 *  the same class; the seeded item's probe reads the node's data since
 *  round 2, a8-tool-content.ts a8ContentProbe). */
const BELOW_ON_FOLDER_DESCRIBE: readonly string[] = [
  'tool:folder_describe mcp-oauth login/readGrant edit branch @root',
  'tool:folder_describe mcp-oauth login/readGrant edit branch @folder',
  // Round 2: a Files folder, so the turn reaches the edit too.
  'tool:folder_describe web-turn turn/readGrant edit branch @root',
  'tool:folder_describe web-turn turn/readGrant edit branch @folder',
];

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

/** S11a-2. app_snapshot_delete deletes an app's snapshot for a caller who
 *  may not change the app's code (the oracle: a Moderator of its home): a
 *  read grant's member at the root, a Write grant's in the folder, in both
 *  modes. The content's own delete (content app-snapshots.ts
 *  deleteAppSnapshot) asks no right and the database's check lets the row
 *  go. Owner's to decide (product code, not S11a's). */
const S11A_2 = 'S11a-2 app_snapshot_delete deletes for a caller who may not change the code';
const SNAPSHOT_DELETE_LOOSE: readonly string[] = WAYS.flatMap((w) => [
  `tool:app_snapshot_delete ${w}/readGrant editDraft app @root`,
  `tool:app_snapshot_delete ${w}/writeGrant editDraft app @folder`,
]);

/** S11a-3. app_export by a member who reads the app is refused: the export
 *  is filed in the auto-filed folder (files auto-filed.ts), which is Admin
 *  only, so the member's scope has no parent folder to make it in
 *  ("parent folder 'files' not found"). Owner's to decide (where a
 *  member's export lands). */
const S11A_3 = "S11a-3 app_export files a member's export in the Admin-only auto-filed folder";
const MEMBER_EXPORT_REFUSED: readonly string[] = WAYS.flatMap((w) => [
  `tool:app_export ${w}/writeGrant read app @root`,
  `tool:app_export ${w}/homeModerator read app @folder`,
]);

/** S11a-4. app_import through a turn makes the app in the turn's workspace,
 *  and a Write grant's member is no Moderator of theirs (W): the new app is
 *  refused ("You cannot change this item in your workspaces"), where the
 *  oracle answers the file's read only. The other "from a file" tools make
 *  their item where the caller may. Owner's to decide. */
const S11A_4 = "S11a-4 app_import through a writeGrant turn: the new app's home refuses";
const IMPORT_HOME_REFUSED: readonly string[] = [
  'tool:app_import web-turn turn/writeGrant read file @root',
];

/** The actor check modes the surface cells run in (docs/update-prod.md:
 *  off, the fleet's default; warn; on). */
export type CheckMode = 'off' | 'warn' | 'on';
export const CHECK_MODES: readonly CheckMode[] = ['off', 'warn', 'on'];

export type KnownFailure = {
  /** The finding (F1, F2, ...). */
  finding: string;
  /** A piece of the cell's failure reason, as the run prints it. */
  reason: string;
  /** A surface cell: the modes it fails in (all three when not given). */
  modes?: readonly CheckMode[];
};

const known = (finding: string, reason: string, modes?: readonly CheckMode[]): KnownFailure =>
  modes ? { finding, reason, modes } : { finding, reason };

export const KNOWN_FAILURES: Readonly<Record<string, KnownFailure>> = {
  // The tool cells (S11a): P1 in warn, S11a-1 in both modes.
  ...Object.fromEntries(
    [...BELOW_ON_TOOL_CELLS, ...BELOW_ON_TOOL_CELLS_FOLDER].map((name) => [
      name,
      known(P1, 'changed, the oracle denies', ['warn']),
    ]),
  ),
  ...Object.fromEntries(
    BELOW_ON_FOLDER_DESCRIBE.map((name) => [
      name,
      known(P1, 'changed, the oracle denies', ['warn']),
    ]),
  ),
  ...Object.fromEntries(
    HIDDEN_PATH_SHOWS.map((name) => [name, known(S11A_1, "not a random uuid's answer")]),
  ),
  // Round 2 (the seeded content, a8-tool-content.ts): S11a-2 to S11a-4.
  ...Object.fromEntries(
    SNAPSHOT_DELETE_LOOSE.map((name) => [name, known(S11A_2, 'changed, the oracle denies')]),
  ),
  ...Object.fromEntries(
    MEMBER_EXPORT_REFUSED.map((name) => [name, known(S11A_3, 'refused, the oracle allows')]),
  ),
  ...Object.fromEntries(
    IMPORT_HOME_REFUSED.map((name) => [name, known(S11A_4, 'refused, the oracle allows')]),
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
    else if (!why.includes(k.reason)) {
      unexpected.push(`${name}: listed (${k.finding}) for "${k.reason}", fails with: ${why}`);
    }
  }
  const fixed = Object.keys(KNOWN_FAILURES).filter((n) => ours(n) && !failures.has(n));
  if (mode) return { unexpected, fixed: fixed.map((n) => `${n} (check ${mode})`) };
  return { unexpected, fixed };
}
