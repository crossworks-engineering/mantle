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
 *  in off and in warn. */
const BELOW_ON_TOOL_EDITS: readonly string[] = [
  'peer login/readGrant edit formula @folder',
  'pending turn/readGrant edit task @root',
  'recipe turn/readGrant edit formula @root',
  'recipe turn/readGrant edit note @folder',
  'recipe turn/readGrant edit note @root',
  'team-turn turn/readGrant edit note @folder',
  'team-turn turn/readGrant edit task @folder',
  'team-turn turn/readGrant edit task @root',
  'web-turn turn/readGrant edit note @folder',
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
 * whose first word holds a '/'), else the surface cells' in check `mode`.
 * `unexpected`: a failure not listed (for this mode), or listed for another
 * reason (both fail the run); `fixed`: a listed cell that did not fail
 * (take it off the list, or off this mode).
 */
export function sortFailures(
  failures: ReadonlyMap<string, string>,
  grid: boolean,
  mode?: CheckMode,
): { unexpected: string[]; fixed: string[] } {
  const ours = (name: string) =>
    name.split(' ')[0]!.includes('/') === grid &&
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
