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

export const KNOWN_FAILURES: Readonly<Record<string, KnownFailure>> = {
  // The grid (SQL): none since F4.
  // The surface cells (all three check modes unless named): none today.
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
